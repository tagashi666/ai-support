#!/usr/bin/env bash
# Установка ai-support. Идемпотентна: можно запускать повторно.
#
#   ./install.sh           первая установка (с мастером) или обновление (без вопросов)
#   ./install.sh --setup   настроить заново: мастер с проверками сети
#   ./install.sh --check   только проверить .env, порты и связь с интеграциями
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mОшибка:\033[0m %s\n' "$1" >&2; exit 1; }

MODE=install
for arg in "$@"; do
  case "$arg" in
    --setup|setup) MODE=setup ;;
    --check|check) MODE=check ;;
    -h|--help) sed -n '4,6s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) die "Неизвестный аргумент: $arg. Есть --setup и --check" ;;
  esac
done

command -v docker >/dev/null || die "Docker не установлен"
docker compose version >/dev/null 2>&1 || die "Нужен docker compose v2"
command -v openssl >/dev/null || die "Нужен openssl для генерации токена панели"

# Строка JSON из произвольного текста: экранируем \ и ", табы — в пробел.
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}

# Факты хоста для мастера: кто слушает TCP-порты и какие контейнеры запущены
# (сети, network_mode, порты). Мастер работает в контейнере и сам этого не
# видит. Файл локальный, в git и релиз не попадает.
collect_facts() {
  local line id first=1
  {
    printf '{"version":1,"generatedAt":"%s","ss":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if command -v ss >/dev/null; then
      while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        (( first )) || printf ','
        first=0
        json_str "$line"
      done < <(ss -ltnp 2>/dev/null | tail -n +2)
    fi
    printf '],"containers":['
    first=1
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      (( first )) || printf ','
      first=0
      docker inspect --format '{"name":{{json .Name}},"image":{{json .Config.Image}},"networkMode":{{json .HostConfig.NetworkMode}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}},"exposed":{{json .Config.ExposedPorts}},"labels":{{json .Config.Labels}}}' "$id"
    done < <(docker ps -q)
    printf ']}\n'
  } > .setup-facts.json
  chmod 600 .setup-facts.json
}

# Мастер запускается внутри образа: сетевые проверки идут из той же
# docker-сети, что и бот. Каталог установки монтируется в /setup.
# root в контейнере без capabilities не пишет в каталог чужого владельца
# (например, распакованный из архива), поэтому ему возвращаем DAC_OVERRIDE.
run_wizard() {
  local opts=(--rm --no-deps -v "$PWD:/setup")
  [[ -t 0 && -t 1 ]] || opts+=(-T)
  if [[ "${EUID:-$(id -u)}" == 0 ]]; then
    opts+=(--user 0:0 --cap-add DAC_OVERRIDE)
  else
    opts+=(--user "$(id -u):$(id -g)")
  fi
  docker compose run "${opts[@]}" ai-support \
    node dist/cli/setup.js --dir /setup --facts /setup/.setup-facts.json "$@"
}

if [[ "$MODE" == check ]]; then
  [[ -f .env ]] || die "Нет .env — сначала установка: ./install.sh"
  collect_facts
  say "Проверка настроек (ничего не меняется)"
  rc=0
  run_wizard --check || rc=$?
  exit "$rc"
fi

FIRST=0
[[ -f .env ]] || FIRST=1

if [[ ! -f .env ]]; then
  say "Создаю .env из шаблона"
  cp .env.example .env
  chmod 600 .env
  token="$(openssl rand -hex 32)"
  # Только ASCII: заголовок Authorization — ByteString, кириллица его ломает.
  sed -i "s|^PANEL_TOKEN=.*|PANEL_TOKEN=${token}|" .env
  printf '\n\033[1;33mТокен панели:\033[0m %s\n' "$token"
  printf 'Он уже записан в .env. Панель может стартовать без Telegram, Bedolaga и AI.\n\n'
fi

# В файле лежат токены всех интеграций. Даже при permissive umask он должен
# оставаться доступным только владельцу.
chmod 600 .env || die "Не удалось выставить права 600 на .env"

SETUP=0
if [[ "$MODE" == setup || "$FIRST" == 1 ]]; then
  if [[ -t 0 && -t 1 ]]; then
    SETUP=1
  else
    warn "Нет терминала — мастер настройки пропущен. Запустите в терминале: ./install.sh --setup"
  fi
fi

# Значение переменной из .env: последнее присваивание, без кавычек, лишних
# пробелов, CR из Windows и необязательного export. Раньше здесь стоял grep по
# всей строке, и любой из этих вариантов записи давал «не заполнен» на
# совершенно корректном токене.
env_value() {
  sed -n "s/^[[:space:]]*\\(export[[:space:]]\\+\\)\\?$1[[:space:]]*=//p" .env \
    | tail -n1 \
    | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

mask() { local v="$1"; [[ ${#v} -le 8 ]] && printf '%s' "$v" || printf '%s…%s' "${v:0:4}" "${v: -4}"; }

if (( SETUP )); then
  # Мастеру нужен собранный образ: сначала каталоги и сборка.
  mkdir -p data kb
  for dir in data kb; do
    chown -R 1000:1000 "$dir" 2>/dev/null || true
  done
  say "Собираю образ"
  docker compose build
  say "Собираю сведения о сервере: занятые порты и контейнеры"
  collect_facts
  if [[ "$MODE" == setup ]] && [[ -n "$(docker compose ps -q ai-support 2>/dev/null)" ]]; then
    # Иначе getUpdates мастера получит 409: Telegram отдаёт сообщения одному процессу.
    say "Останавливаю работающий ai-support на время настройки"
    docker compose stop ai-support
  fi
  say "Мастер настройки"
  rc=0
  run_wizard || rc=$?
  if (( rc == 3 )); then
    die "Мастер отменён, .env не изменён. Повторить: ./install.sh --setup"
  elif (( rc != 0 )); then
    die "Мастер завершился с ошибкой (код $rc). Повторить: ./install.sh --setup"
  fi
fi

# Обновление на новую версию: .env.example делится на активные строки блока
# «Обязательно» (пустые значения) и закомментированные необязательные ключи.
# Дописываем в .env только недостающие обязательные ключи, и только пустыми.
# Необязательные не дописываем вовсе: умолчания живут в коде, а их копия в
# .env перекрывала бы улучшения в следующих версиях. Существующие строки
# .env не меняются и не удаляются.
added=()
while IFS= read -r key; do
  grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" .env || added+=("$key")
done < <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' .env.example)

if (( ${#added[@]} > 0 )); then
  say "В .env дописаны обязательные ключи из шаблона (пустые): ${added[*]}"
  {
    printf '\n# --- добавлено при обновлении %s ---\n' "$(date +%F)"
    printf '%s=\n' "${added[@]}"
  } >> .env
  echo "    Заполните их при необходимости. Остальные настройки необязательны:"
  echo "    без них работают умолчания кода, описание — в .env.example."
fi

BOT_TOKEN_VALUE="$(env_value BOT_TOKEN)"
if [[ -n "$BOT_TOKEN_VALUE" ]]; then
  [[ "$BOT_TOKEN_VALUE" == 123456:AA* ]] && die "BOT_TOKEN остался плейсхолдером из шаблона — вставь настоящий из @BotFather"
  [[ "$BOT_TOKEN_VALUE" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] \
    || die "BOT_TOKEN не похож на токен Telegram (найдено: $(mask "$BOT_TOKEN_VALUE")). Формат: 1234567890:AA..."
else
  warn "BOT_TOKEN пуст — оба Telegram-канала отключены, панель продолжит работать"
fi

PANEL_TOKEN_VALUE="$(env_value PANEL_TOKEN)"
[[ -n "$PANEL_TOKEN_VALUE" ]] || die "В .env пусто значение PANEL_TOKEN. Сгенерируй: openssl rand -hex 32"
if (( ${#PANEL_TOKEN_VALUE} < 16 )); then
  die "PANEL_TOKEN короче 16 символов (найдено ${#PANEL_TOKEN_VALUE}: $(mask "$PANEL_TOKEN_VALUE"))"
fi
# Заголовок Authorization — ByteString: кириллица и пробелы в него не пролезут.
if printf '%s' "$PANEL_TOKEN_VALUE" | LC_ALL=C grep -q '[^[:graph:]]'; then
  die "PANEL_TOKEN содержит пробелы или не-ASCII символы. Сгенерируй: openssl rand -hex 32"
fi

AI_MODE_VALUE="$(env_value AI_MODE)"
AI_KEY_VALUE="$(env_value AI_API_KEY)"
if [[ "$AI_MODE_VALUE" == "suggest" || "$AI_MODE_VALUE" == "auto" ]] && (( ${#AI_KEY_VALUE} < 10 )); then
  die "AI_MODE=$AI_MODE_VALUE, но AI_API_KEY пуст. Заполни ключ или поставь AI_MODE=off"
fi
[[ "$AI_MODE_VALUE" == "auto" ]] && warn "AI_MODE=auto — ответы уйдут клиентам без подтверждения. Начинать стоит с suggest."

if [[ "$(env_value BEDOLAGA_ENABLED)" == "true" ]]; then
  [[ -n "$(env_value BEDOLAGA_API_URL)" && -n "$(env_value BEDOLAGA_API_TOKEN)" ]] \
    || die "BEDOLAGA_ENABLED=true, но не заполнены BEDOLAGA_API_URL и BEDOLAGA_API_TOKEN"
fi

LEGACY_PORT="$(env_value PANEL_PORT)"
if [[ -n "$LEGACY_PORT" && "$LEGACY_PORT" != 8080 ]]; then
  warn "PANEL_PORT=$LEGACY_PORT в .env не действует в Docker (внутри всегда 8080). Внешний порт — PANEL_PUBLISH_PORT"
fi
PUBLISH_PORT="$(env_value PANEL_PUBLISH_PORT)"
PUBLISH_PORT="${PUBLISH_PORT:-8080}"
if ! [[ "$PUBLISH_PORT" =~ ^[0-9]+$ ]] || (( PUBLISH_PORT < 1 || PUBLISH_PORT > 65535 )); then
  die "PANEL_PUBLISH_PORT должен быть номером порта 1–65535 (найдено: $PUBLISH_PORT)"
fi
PUBLISH_BIND="$(env_value PANEL_BIND)"
PUBLISH_BIND="${PUBLISH_BIND:-127.0.0.1}"

say "Конфигурация проверена"
printf '    бот      %s\n' "$([[ -n "$BOT_TOKEN_VALUE" ]] && mask "$BOT_TOKEN_VALUE" || printf 'отключён')"
printf '    панель   %s\n' "$(mask "$PANEL_TOKEN_VALUE")"
printf '    AI       %s\n' "${AI_MODE_VALUE:-$([[ ${#AI_KEY_VALUE} -ge 10 ]] && echo suggest || echo off)}"

# Контейнер работает под пользователем node (uid 1000). Каталог данных обычно
# создаётся от root, и без chown приложение не сможет записать базу.
# Распаковка поверх не удаляет файлы, которых в новой версии больше нет.
# После перестановки модулей на сервере оставались и старый src/core.ts,
# и новый src/core/store.ts — сборка падала на конфликте типов.
if [[ -f MANIFEST && ! -d .git ]]; then
  stale=0
  while IFS= read -r -d '' file; do
    rel="${file#./}"
    if ! grep -Fxq "$rel" MANIFEST; then
      rm -f "$file"
      stale=$((stale + 1))
    fi
  done < <(find src scripts public deploy -type f -print0 2>/dev/null)
  find src scripts public deploy -type d -empty -delete 2>/dev/null || true
  if (( stale > 0 )); then
    say "Убрано файлов от прошлых версий: $stale"
  fi
fi

say "Готовлю каталоги"
mkdir -p data kb
# kb тоже на запись: панель редактирует статьи и публикует черновики.
# Без этого публикация падала с EACCES, а кнопка выглядела мёртвой.
for dir in data kb; do
  chown -R 1000:1000 "$dir" 2>/dev/null \
    || warn "Не удалось выставить владельца ./$dir — выполни вручную: chown -R 1000:1000 $dir"
done

if (( ! SETUP )); then
  say "Собираю образ"
  docker compose build
fi

say "Предполётная проверка"
docker compose run --rm ai-support node dist/cli/selfcheck.js || die "Проверка не прошла — смотри вывод выше"

# Кто держит порт на хосте. Пусто — свободен или держит наш же контейнер.
port_owner() {
  local port="$1" bind="$2" line who name
  # Наш контейнер на этом порту — это перезапуск, а не конфликт.
  if docker ps --filter 'name=^ai-support$' --format '{{.Ports}}' | grep -Eq "[:.]${port}->8080/tcp"; then
    return 0
  fi
  command -v ss >/dev/null || return 0
  line="$(ss -ltnp "sport = :$port" 2>/dev/null | tail -n +2 \
    | awk -v bind="$bind" '{ addr=$4; sub(/:[0-9]+$/, "", addr); gsub(/[][]/, "", addr);
        if (addr=="0.0.0.0" || addr=="*" || addr=="::" || bind=="0.0.0.0" || addr==bind) { print; exit } }')"
  [[ -n "$line" ]] || return 0
  who="$(sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1 (pid \2)/p' <<<"$line")"
  if [[ "$who" == docker-proxy* ]]; then
    name="$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E "[:.]${port}->" | cut -d' ' -f1 | head -n1)"
    [[ -n "$name" ]] && who="контейнер $name"
  fi
  printf '%s' "${who:-неизвестный процесс (запустите от root, чтобы увидеть имя)}"
}

busy="$(port_owner "$PUBLISH_PORT" "$PUBLISH_BIND")"
if [[ -n "$busy" ]]; then
  die "Порт $PUBLISH_PORT на хосте занят: $busy.
Освободите его или задайте другой: PANEL_PUBLISH_PORT=<порт> в .env (или ./install.sh --setup — мастер подберёт свободный)."
fi

say "Запускаю"
docker compose up -d

say "Жду, пока панель ответит (до 90 с)"
health=""
for _ in $(seq 1 45); do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ai-support 2>/dev/null || echo missing)"
  [[ "$health" == healthy || "$health" == unhealthy ]] && break
  sleep 2
done
if [[ "$health" != healthy ]]; then
  printf '\n\033[1;31mПанель не поднялась\033[0m (статус: %s). Последние строки лога:\n\n' "${health:-?}" >&2
  docker compose logs --tail 30 ai-support >&2 || true
  die "Проверьте настройки: ./install.sh --check, поменять их — ./install.sh --setup"
fi

if [[ "${EUID:-$(id -u)}" == 0 ]]; then
  say "Включаю безопасное обновление по кнопке"
  bash scripts/install-host-updater.sh "$PWD" \
    || die "Не удалось установить host-updater — обновление по кнопке не будет работать"
else
  warn "Для обновления по кнопке один раз выполни от root: sudo bash scripts/install-host-updater.sh '$PWD'"
fi

say "Готово"
docker compose ps
printf '\nПанель на сервере: http://%s:%s\n' "$PUBLISH_BIND" "$PUBLISH_PORT"
if [[ "$PUBLISH_BIND" == 127.0.0.1 ]]; then
  printf 'С компьютера:      ssh -N -L 8080:127.0.0.1:%s root@<IP-сервера>, затем http://localhost:8080\n' "$PUBLISH_PORT"
fi
PANEL_URL_VALUE="$(env_value PANEL_URL)"
[[ -n "$PANEL_URL_VALUE" ]] && printf 'Внешний адрес:     %s\n' "$PANEL_URL_VALUE"
printf 'Токен входа:       grep PANEL_TOKEN .env\n'
printf 'Логи:              docker compose logs -f\n'
printf 'Проверка/настройка: ./install.sh --check | ./install.sh --setup\n\n'
