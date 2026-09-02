#!/usr/bin/env bash
# Привилегированный исполнитель one-click обновлений. Веб-приложение не
# получает Docker socket: оно может только положить строго проверяемый запрос
# в data/update-request.json, а этот скрипт запускается отдельным systemd unit.
set -Eeuo pipefail
umask 077

PROJECT_ROOT="${1:-/root/ai-support}"
PROJECT_ROOT="$(readlink -f -- "$PROJECT_ROOT")"
DATA_DIR="$PROJECT_ROOT/data"
REQUEST_FILE="$DATA_DIR/update-request.json"
STATUS_FILE="$DATA_DIR/update-status.json"
STATE_DIR="/var/lib/ai-support-updater"
STATE_FILE="$STATE_DIR/state.json"
OVERRIDE_FILE="$STATE_DIR/update-compose.override.yml"
BACKUP_DIR="/var/backups/ai-support"
INBOX_FILE="$STATE_DIR/request.json"
LOCK_FILE="/run/lock/ai-support-updater.lock"
REPOSITORY="tagashi666/ai-support"
CONTAINER="ai-support"
ACTION="update"
TARGET_VERSION=""
BACKUP_PATH=""
ROLLBACK_IMAGE=""
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WORK_DIR=""
DB_TEMP_NAME=""
SWITCHED=0

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'ai-support updater: не найдена команда %s\n' "$1" >&2
    exit 1
  }
}

for command in curl docker flock install nginx node python3 readlink sha256sum tar; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || {
  printf 'ai-support updater: нужен docker compose v2\n' >&2
  exit 1
}

[[ "$PROJECT_ROOT" == /* && "$PROJECT_ROOT" != / ]] || {
  printf 'ai-support updater: небезопасный каталог проекта\n' >&2
  exit 1
}
[[ -f "$PROJECT_ROOT/docker-compose.yml" && -f "$PROJECT_ROOT/.env" ]] || {
  printf 'ai-support updater: в %s нет docker-compose.yml или .env\n' "$PROJECT_ROOT" >&2
  exit 1
}

install -d -m 0700 "$STATE_DIR" "$BACKUP_DIR"
export DOCKER_CONFIG="$STATE_DIR/docker-config"
install -d -m 0700 "$DOCKER_CONFIG"
mkdir -p "$DATA_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

write_status() {
  local status="$1" stage="$2" percent="$3" detail="${4:-}" backup="${5:-$BACKUP_PATH}" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node -e '
    const fs = require("fs");
    const [out, action, status, stage, percent, version, backupPath, detail, startedAt, updatedAt] = process.argv.slice(1);
    const value = { action, status, stage, percent: Number(percent), startedAt, updatedAt };
    if (version) value.version = version;
    if (backupPath) value.backupPath = backupPath;
    if (detail) value.detail = detail;
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644, flag: "wx" });
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, out);
  ' "$STATUS_FILE" "$ACTION" "$status" "$stage" "$percent" "$TARGET_VERSION" "$backup" "$detail" "$STARTED_AT" "$now"
}

write_state() {
  local rollback_image="$1" backup_path="$2" previous_version="$3" installed_version="$4"
  node -e '
    const fs = require("fs");
    const [out, rollbackImage, backupPath, previousVersion, installedVersion, updatedAt] = process.argv.slice(1);
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ schema: 1, rollbackImage, backupPath, previousVersion, installedVersion, updatedAt }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, out);
  ' "$STATE_FILE" "$rollback_image" "$backup_path" "$previous_version" "$installed_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

write_override() {
  local image="$1" temporary="${OVERRIDE_FILE}.$$.tmp"
  [[ "$image" =~ ^ai-support:(release|rollback)-[0-9A-Za-z._-]+$ ]] || return 1
  printf 'services:\n  ai-support:\n    image: %s\n' "$image" > "$temporary"
  chmod 0644 "$temporary"
  mv -fT -- "$temporary" "$OVERRIDE_FILE"
}

compose() {
  docker compose --project-directory "$PROJECT_ROOT" \
    -f "$PROJECT_ROOT/docker-compose.yml" -f "$OVERRIDE_FILE" "$@"
}

cleanup() {
  if [[ -n "$DB_TEMP_NAME" && "$DB_TEMP_NAME" =~ ^\.host-updater-[0-9A-Za-z._-]+\.db$ ]]; then
    rm -f -- "$DATA_DIR/$DB_TEMP_NAME"
  fi
  if [[ -n "$WORK_DIR" && "$WORK_DIR" == /tmp/ai-support-updater.* && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

backup_db() {
  local destination="$1"
  DB_TEMP_NAME=".host-updater-${$}-${RANDOM}.db"
  docker exec "$CONTAINER" node -e '
    const Database = require("better-sqlite3");
    (async () => {
      const [source, destination] = process.argv.slice(1);
      const db = new Database(source);
      await db.backup(destination);
      db.close();
      const copy = new Database(destination, { readonly: true });
      const result = copy.pragma("quick_check", { simple: true });
      copy.close();
      if (result !== "ok") throw new Error(`quick_check: ${result}`);
    })().catch((error) => { console.error(error.message); process.exit(1); });
  ' /app/data/ai-support.db "/app/data/$DB_TEMP_NAME"
  [[ -f "$DATA_DIR/$DB_TEMP_NAME" && ! -L "$DATA_DIR/$DB_TEMP_NAME" ]] || return 1
  install -o root -g root -m 0600 -- "$DATA_DIR/$DB_TEMP_NAME" "$destination"
  rm -f -- "$DATA_DIR/$DB_TEMP_NAME"
  DB_TEMP_NAME=""
}

restore_release() {
  local image="$1" database="$2" restore_tmp="$DATA_DIR/.host-updater-restore-$$.db"
  [[ "$database" == "$BACKUP_DIR/"* && -f "$database" && ! -L "$database" ]] || return 1
  compose stop "$CONTAINER"
  install -o 1000 -g 1000 -m 0600 -- "$database" "$restore_tmp"
  rm -f -- "$DATA_DIR/ai-support.db-wal" "$DATA_DIR/ai-support.db-shm"
  mv -fT -- "$restore_tmp" "$DATA_DIR/ai-support.db"
  write_override "$image"
  compose up -d --no-build "$CONTAINER"
}

wait_for_health() {
  local health state attempt
  for attempt in $(seq 1 90); do
    state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || true)"
    if [[ "$state" == running && "$health" == healthy ]]; then
      break
    fi
    sleep 2
  done
  [[ "$state" == running && "$health" == healthy ]]

  [[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 10 http://127.0.0.1:8080/)" == 200 ]]
  docker exec "$CONTAINER" node -e '
    const Database = require("better-sqlite3");
    const db = new Database("/app/data/ai-support.db", { readonly: true });
    const result = db.pragma("quick_check", { simple: true });
    db.close();
    if (result !== "ok") throw new Error(`quick_check: ${result}`);
  '
  docker exec "$CONTAINER" node -e '
    fetch("http://127.0.0.1:8080/api/health", { headers: { authorization: `Bearer ${process.env.PANEL_TOKEN}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`health HTTP ${response.status}`);
        const body = await response.json();
        if (body.ok !== true || typeof body.kb !== "number") throw new Error("некорректный health payload");
      })
      .catch((error) => { console.error(error.message); process.exit(1); });
  '
  nginx -t
}

on_error() {
  local code="$?"
  local line="${1:-unknown}"
  local detail="Сбой на строке $line (код $code)."
  trap - ERR
  set +e
  if [[ "$SWITCHED" == 1 && -n "$ROLLBACK_IMAGE" && -n "$BACKUP_PATH" ]]; then
    write_status checking "Автоматический откат" 92 "$detail"
    if restore_release "$ROLLBACK_IMAGE" "$BACKUP_PATH" && wait_for_health; then
      detail="$detail Предыдущая версия и база автоматически восстановлены."
    else
      detail="$detail Автоматический откат тоже завершился ошибкой; требуется ручная проверка."
    fi
  fi
  write_status failed "Обновление остановлено" 100 "$detail"
  exit "$code"
}
trap 'on_error "$LINENO"' ERR

load_rollback_state() {
  local parsed="$WORK_DIR/state.txt"
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || return 1
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.schema !== 1) throw new Error("schema");
    if (!/^ai-support:rollback-[0-9A-Za-z._-]+$/.test(value.rollbackImage || "")) throw new Error("image");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.previousVersion || "")) throw new Error("version");
    console.log(value.rollbackImage);
    console.log(value.backupPath);
    console.log(value.previousVersion);
  ' "$STATE_FILE" > "$parsed"
  mapfile -t ROLLBACK_STATE < "$parsed"
  [[ "${#ROLLBACK_STATE[@]}" == 3 ]]
}

build_image() {
  local image="$1" source_dir="$2" progress_pid elapsed=0 percent=36 rc=0

  # docker build может несколько минут не печатать ничего полезного для панели.
  # Отдельный heartbeat показывает, что host-updater жив, и постепенно двигает
  # индикатор, не выдавая оценку времени за реальный прогресс слоёв Docker.
  (
    while sleep 5; do
      elapsed=$((elapsed + 5))
      percent=$((36 + elapsed / 10))
      (( percent > 54 )) && percent=54
      write_status installing "Сборка изолированного образа · ${elapsed} с" "$percent"
    done
  ) &
  progress_pid="$!"

  docker build --tag "$image" "$source_dir" || rc="$?"
  kill "$progress_pid" 2>/dev/null || true
  wait "$progress_pid" 2>/dev/null || true
  return "$rc"
}

do_update() {
  local current_version="$1" tag="$2" safe_tag archive checksum source_dir
  local current_image_id stamp backup_folder
  TARGET_VERSION="${tag#v}"
  safe_tag="${TARGET_VERSION//./-}"
  safe_tag="${safe_tag//[^0-9A-Za-z_-]/-}"
  local target_image="ai-support:release-$safe_tag"

  write_status installing "Скачивание подписанного релиза" 8
  archive="$WORK_DIR/ai-support.tar.gz"
  checksum="$WORK_DIR/ai-support.tar.gz.sha256"
  local base_url="https://github.com/$REPOSITORY/releases/download/$tag"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --connect-timeout 10 --max-time 300 \
    --output "$archive" "$base_url/ai-support.tar.gz"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --connect-timeout 10 --max-time 60 \
    --output "$checksum" "$base_url/ai-support.tar.gz.sha256"
  [[ "$(wc -l < "$checksum")" == 1 ]]
  grep -Eq '^[0-9a-f]{64}  ai-support\.tar\.gz$' "$checksum"
  (cd "$WORK_DIR" && sha256sum --check ai-support.tar.gz.sha256)

  write_status installing "Проверка состава релиза" 20
  python3 - "$archive" <<'PY'
import pathlib
import sys
import tarfile

archive = sys.argv[1]
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if not members:
        raise SystemExit("пустой архив")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "ai-support":
            raise SystemExit(f"небезопасный путь в архиве: {member.name}")
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"запрещённый тип в архиве: {member.name}")
PY
  mkdir -m 0700 "$WORK_DIR/unpacked"
  tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$WORK_DIR/unpacked"
  source_dir="$WORK_DIR/unpacked/ai-support"
  [[ -f "$source_dir/Dockerfile" && -f "$source_dir/package.json" ]]
  [[ "$(node -p 'require(process.argv[1]).version' "$source_dir/package.json")" == "$TARGET_VERSION" ]]

  write_status installing "Сборка изолированного образа" 36
  build_image "$target_image" "$source_dir"

  write_status backing_up "Резервная копия базы" 58
  current_image_id="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
  [[ "$current_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_folder="$BACKUP_DIR/${stamp}-${current_version}-to-${TARGET_VERSION}"
  install -d -m 0700 "$backup_folder"
  BACKUP_PATH="$backup_folder/ai-support.db"
  backup_db "$BACKUP_PATH"
  ROLLBACK_IMAGE="ai-support:rollback-$stamp"
  docker image tag "$current_image_id" "$ROLLBACK_IMAGE"
  write_state "$ROLLBACK_IMAGE" "$BACKUP_PATH" "$current_version" "$TARGET_VERSION"

  write_status installing "Атомарное переключение контейнера" 72
  write_override "$target_image"
  SWITCHED=1
  compose up -d --no-build "$CONTAINER"

  write_status checking "Проверка приложения, базы, каналов и nginx" 86
  wait_for_health
  SWITCHED=0
  write_status completed "Обновление установлено" 100 \
    "Версия $TARGET_VERSION запущена; резервная копия оставлена для отката."
}

do_rollback() {
  local current_version="$1" target_image target_db previous_version
  local current_image_id stamp rescue_folder rescue_image rescue_db
  load_rollback_state
  target_image="${ROLLBACK_STATE[0]}"
  target_db="${ROLLBACK_STATE[1]}"
  previous_version="${ROLLBACK_STATE[2]}"
  [[ "$target_db" == "$BACKUP_DIR/"* && -f "$target_db" && ! -L "$target_db" ]]
  TARGET_VERSION="$previous_version"

  write_status backing_up "Страховочная копия перед откатом" 25
  current_image_id="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  rescue_folder="$BACKUP_DIR/${stamp}-before-rollback"
  install -d -m 0700 "$rescue_folder"
  rescue_db="$rescue_folder/ai-support.db"
  backup_db "$rescue_db"
  rescue_image="ai-support:rollback-${stamp}-undo"
  docker image tag "$current_image_id" "$rescue_image"

  BACKUP_PATH="$rescue_db"
  ROLLBACK_IMAGE="$rescue_image"
  SWITCHED=1
  write_status installing "Восстановление выбранной версии и базы" 55
  restore_release "$target_image" "$target_db"
  write_status checking "Проверка после отката" 82
  wait_for_health
  SWITCHED=0
  write_state "$rescue_image" "$rescue_db" "$current_version" "$previous_version"
  write_status rolled_back "Откат завершён" 100 \
    "Восстановлена версия $previous_version; страховочная копия новой версии сохранена."
}

# Ручной `systemctl start ai-support-updater.service` без запроса служит
# безопасным self-check самого unit: Docker socket, приложение, БД и nginx.
[[ -e "$REQUEST_FILE" ]] || {
  wait_for_health
  exit 0
}
[[ -f "$REQUEST_FILE" && ! -L "$REQUEST_FILE" ]] || {
  write_status failed "Запрос отклонён" 100 "Файл запроса имеет запрещённый тип."
  exit 1
}
[[ "$(stat -c %s "$REQUEST_FILE")" -le 65536 ]] || {
  write_status failed "Запрос отклонён" 100 "Файл запроса слишком большой."
  exit 1
}
rm -f -- "$INBOX_FILE"
mv -T -- "$REQUEST_FILE" "$INBOX_FILE"
[[ -f "$INBOX_FILE" && ! -L "$INBOX_FILE" ]]

WORK_DIR="$(mktemp -d -p /tmp ai-support-updater.XXXXXXXX)"
chmod 0700 "$WORK_DIR"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const tag = value.action === "update" ? value.tag : "";
  if (value.schema !== 2 || !["update", "rollback"].includes(value.action)) throw new Error("schema/action");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.current || "")) throw new Error("current");
  if (value.action === "update" && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag || "")) throw new Error("tag");
  if (value.safety?.backupRequired !== true || value.safety?.rollbackOnFailure !== true) throw new Error("safety");
  console.log(value.action);
  console.log(tag);
  console.log(value.current);
' "$INBOX_FILE" > "$WORK_DIR/request.txt"
mapfile -t REQUEST < "$WORK_DIR/request.txt"
[[ "${#REQUEST[@]}" == 3 ]]
ACTION="${REQUEST[0]}"
TAG="${REQUEST[1]}"
CURRENT_VERSION="${REQUEST[2]}"
write_status queued "Запрос принят host-updater" 2

if [[ "$ACTION" == update ]]; then
  do_update "$CURRENT_VERSION" "$TAG"
else
  do_rollback "$CURRENT_VERSION"
fi
