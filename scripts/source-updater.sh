#!/usr/bin/env bash
# Ограниченный исполнитель добавления источников. Веб-процесс создаёт один
# приватный request-файл; только этот root-only процесс меняет .env и
# пересоздаёт контейнер. Nginx, firewall и остальные сервисы не изменяются.
set -Eeuo pipefail
umask 077

PROJECT_ROOT="$(readlink -f -- "${1:-/root/ai-support}")"
DATA_DIR="$PROJECT_ROOT/data"
REQUEST_FILE="$DATA_DIR/source-request.json"
STATUS_FILE="$DATA_DIR/source-status.json"
STATE_DIR="/var/lib/ai-support-updater"
INBOX_FILE="$STATE_DIR/source-request.json"
OVERRIDE_FILE="$STATE_DIR/update-compose.override.yml"
BACKUP_DIR="/var/backups/ai-support"
LOCK_FILE="/run/lock/ai-support-source-updater.lock"
CONTAINER="ai-support"
ENV_FILE="$PROJECT_ROOT/.env"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BACKUP_PATH=""
CANDIDATE=""
META_FILE=""
SWITCHED=0
SOURCE_KIND=""
SOURCE_ID=""
SOURCE_NAME=""

for command in docker flock nginx node readlink; do
  command -v "$command" >/dev/null 2>&1 || { printf 'source updater: не найдена команда %s\n' "$command" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo 'source updater: нужен docker compose v2' >&2; exit 1; }
[[ "$PROJECT_ROOT" == /* && "$PROJECT_ROOT" != / && -f "$PROJECT_ROOT/docker-compose.yml" && -f "$ENV_FILE" ]] || {
  echo 'source updater: небезопасный или неполный каталог проекта' >&2; exit 1;
}
install -d -m 0700 "$STATE_DIR" "$BACKUP_DIR"
mkdir -p "$DATA_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

write_status() {
  local status="$1" stage="$2" detail="${3:-}" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node -e '
    const fs = require("fs");
    const [out,status,stage,detail,kind,id,name,backupPath,requestedAt,updatedAt] = process.argv.slice(1);
    const value={status,stage,requestedAt,updatedAt};
    if(detail)value.detail=detail;if(kind)value.kind=kind;if(id)value.id=id;if(name)value.name=name;if(backupPath)value.backupPath=backupPath;
    const tmp=`${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp,`${JSON.stringify(value,null,2)}\n`,{mode:0o644,flag:"wx"});
    fs.chmodSync(tmp,0o644);fs.renameSync(tmp,out);
  ' "$STATUS_FILE" "$status" "$stage" "$detail" "$SOURCE_KIND" "$SOURCE_ID" "$SOURCE_NAME" "$BACKUP_PATH" "$STARTED_AT" "$now"
}

compose() {
  local args=(--project-directory "$PROJECT_ROOT" -f "$PROJECT_ROOT/docker-compose.yml")
  if [[ -f "$OVERRIDE_FILE" && ! -L "$OVERRIDE_FILE" ]]; then args+=(-f "$OVERRIDE_FILE"); fi
  docker compose "${args[@]}" "$@"
}

wait_for_health() {
  local state='' health='' attempt
  for attempt in $(seq 1 90); do
    state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || true)"
    [[ "$state" == running && "$health" == healthy ]] && break
    sleep 2
  done
  [[ "$state" == running && "$health" == healthy ]]
  docker exec "$CONTAINER" node -e '
    fetch("http://127.0.0.1:8080/api/health",{headers:{authorization:`Bearer ${process.env.PANEL_TOKEN}`}})
      .then(async r=>{if(!r.ok)throw new Error(`health HTTP ${r.status}`);const b=await r.json();if(b.ok!==true)throw new Error("bad health")})
      .catch(e=>{console.error(e.message);process.exit(1)})'
  nginx -t
}

cleanup() {
  rm -f -- "$INBOX_FILE"
  [[ -z "$CANDIDATE" || "$CANDIDATE" != "$PROJECT_ROOT"/.env.source.* ]] || rm -f -- "$CANDIDATE"
  [[ -z "$META_FILE" || "$META_FILE" != /tmp/ai-support-source-meta.* ]] || rm -f -- "$META_FILE"
}
trap cleanup EXIT

on_error() {
  local code="$?" line="${1:-unknown}" detail="Сбой на строке ${1:-unknown} (код $code)."
  trap - ERR
  set +e
  if [[ "$SWITCHED" == 1 && -n "$BACKUP_PATH" && -f "$BACKUP_PATH" ]]; then
    install -o root -g root -m 0600 -- "$BACKUP_PATH" "$PROJECT_ROOT/.env.rollback.$$"
    mv -fT -- "$PROJECT_ROOT/.env.rollback.$$" "$ENV_FILE"
    if compose up -d --no-build --force-recreate "$CONTAINER" && wait_for_health; then
      detail="$detail Предыдущая конфигурация автоматически восстановлена."
    else
      detail="$detail Автоматический откат тоже завершился ошибкой; требуется ручная проверка."
    fi
  fi
  write_status failed 'Добавление источника остановлено' "$detail"
  exit "$code"
}
trap 'on_error "$LINENO"' ERR

[[ -e "$REQUEST_FILE" ]] || { wait_for_health; exit 0; }
[[ -f "$REQUEST_FILE" && ! -L "$REQUEST_FILE" && "$(stat -c %s "$REQUEST_FILE")" -le 65536 ]] || {
  write_status failed 'Запрос отклонён' 'Файл запроса имеет запрещённый тип или размер.'; exit 1;
}
rm -f -- "$INBOX_FILE"
mv -T -- "$REQUEST_FILE" "$INBOX_FILE"
[[ -f "$INBOX_FILE" && ! -L "$INBOX_FILE" ]]

CANDIDATE="$(mktemp "$PROJECT_ROOT/.env.source.XXXXXXXX")"
META_FILE="$(mktemp /tmp/ai-support-source-meta.XXXXXXXX)"
node - "$INBOX_FILE" "$ENV_FILE" "$CANDIDATE" "$META_FILE" <<'NODE'
const fs = require('fs');
const [requestPath, envPath, outputPath, metaPath] = process.argv.slice(2);
const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
if (req.schema !== 1 || req.action !== 'add_source' || req.safety?.backupRequired !== true || req.safety?.rollbackOnFailure !== true) throw new Error('invalid request');
const s = req.source;
const idRe=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const clean=(v,max=120)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\r\n\0#]/.test(v);
if(!s||!['telegram_bot','remnawave'].includes(s.kind)||!idRe.test(s.id||'')||!clean(s.name)||!clean(s.token,2000)) throw new Error('invalid source');
if(s.kind==='telegram_bot'&&!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(s.token))throw new Error('invalid bot token');
if(s.kind==='remnawave'){
  const u=new URL(s.url); if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw new Error('invalid panel URL');
}
const raw=fs.readFileSync(envPath,'utf8');
const lines=raw.split(/\n/);
const values={};
for(const line of lines){const m=/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim().replace(/\r$/,''));if(m)values[m[1]]=m[2].trim().replace(/^"(.*)"$/s,'$1').replace(/^'(.*)'$/s,'$1');}
const array=(key)=>{if(!values[key])return [];const parsed=JSON.parse(values[key]);if(!Array.isArray(parsed))throw new Error(`${key} is not array`);return parsed;};
let key, list;
if(s.kind==='telegram_bot'){
  key='TELEGRAM_BOTS_JSON'; list=array(key);
  if(!list.length&&values.BOT_TOKEN)list.push({id:'telegram-default',name:'Telegram',token:values.BOT_TOKEN});
  if(list.some(x=>x.id===s.id))throw new Error('duplicate source id');
  list.push({id:s.id,name:s.name,token:s.token});
}else{
  key='REMNAWAVE_PANELS_JSON'; list=array(key);
  if(!list.length&&/^(1|true|yes|on|да)$/i.test(values.REMNAWAVE_ENABLED||'')) list.push({id:'remnawave-default',name:'Remnawave',url:values.REMNAWAVE_URL||'',token:values.REMNAWAVE_TOKEN||'',readOnly:!(/^(0|false|no|off|нет)$/i.test(values.REMNAWAVE_READONLY||''))});
  if(list.some(x=>x.id===s.id))throw new Error('duplicate source id');
  list.push({id:s.id,name:s.name,url:s.url,token:s.token,readOnly:s.readOnly!==false});
}
const replacement=`${key}=${JSON.stringify(list)}`;
let replaced=false;
const next=lines.map(line=>{if(new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(line.trim())&&!replaced){replaced=true;return replacement;}return line;});
if(!replaced)next.push(replacement);
fs.writeFileSync(outputPath,next.join('\n'),{mode:0o600});fs.chmodSync(outputPath,0o600);
fs.writeFileSync(metaPath,`${s.kind}\n${s.id}\n${s.name}\n`,{mode:0o600});
NODE
mapfile -t SOURCE_META < "$META_FILE"
[[ "${#SOURCE_META[@]}" == 3 ]]
SOURCE_KIND="${SOURCE_META[0]}"; SOURCE_ID="${SOURCE_META[1]}"; SOURCE_NAME="${SOURCE_META[2]}"
write_status queued 'Запрос принят исполнителем'

# Проверяем, что текущий образ способен прочитать будущий env, ещё до замены.
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
docker run --rm --env-file "$CANDIDATE" --entrypoint node "$IMAGE" -e "import('/app/dist/config.js').catch(e=>{console.error(e.message);process.exit(1)})"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$BACKUP_DIR/${STAMP}-before-source-${SOURCE_ID}.env"
write_status backing_up 'Резервная копия конфигурации'
install -o root -g root -m 0600 -- "$ENV_FILE" "$BACKUP_PATH"
[[ "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" == "$(sha256sum "$BACKUP_PATH" | cut -d' ' -f1)" ]]

write_status applying 'Применение источника'
SWITCHED=1
mv -fT -- "$CANDIDATE" "$ENV_FILE"; CANDIDATE=''
chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"
compose up -d --no-build --force-recreate "$CONTAINER"
write_status checking 'Проверка приложения и конфигурации'
wait_for_health
SWITCHED=0
write_status completed 'Источник подключён' 'Приложение запущено с новой конфигурацией; резервная копия оставлена для ручного отката.'
