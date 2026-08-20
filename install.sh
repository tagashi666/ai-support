#!/usr/bin/env bash
# Установка ai-support. Идемпотентна: можно запускать повторно.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mОшибка:\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null || die "Docker не установлен"
docker compose version >/dev/null 2>&1 || die "Нужен docker compose v2"
command -v openssl >/dev/null || die "Нужен openssl для генерации токена панели"

if [[ ! -f .env ]]; then
  say "Создаю .env из шаблона"
  cp .env.example .env
  chmod 600 .env
  token="$(openssl rand -hex 32)"
  # Только ASCII: заголовок Authorization — ByteString, кириллица его ломает.
  sed -i "s|^PANEL_TOKEN=.*|PANEL_TOKEN=${token}|" .env
  printf '\n\033[1;33mТокен панели:\033[0m %s\n' "$token"
  printf 'Он уже записан в .env. Впиши туда BOT_TOKEN и AI_API_KEY, затем запусти скрипт снова.\n\n'
  exit 0
fi

# В файле лежат токены всех интеграций. Даже при permissive umask он должен
# оставаться доступным только владельцу.
chmod 600 .env || die "Не удалось выставить права 600 на .env"

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

# Обновление на новую версию: в .env.example появляются ключи, которых нет в
# рабочем .env. Молча брать значения по умолчанию — плохо: человек не узнает,
# что настройка вообще существует. Дописываем недостающее с пометкой.
missing=()
while IFS= read -r key; do
  grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" .env || missing+=("$key")
done < <(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env.example)

if (( ${#missing[@]} > 0 )); then
  say "В .env добавились новые ключи из шаблона: ${#missing[@]}"
  {
    printf '\n# --- добавлено при обновлении %s ---\n' "$(date +%F)"
    for key in "${missing[@]}"; do
      grep -E "^${key}=" .env.example | head -n1
    done
  } >> .env
  printf '    %s\n' "${missing[@]}"
  echo
  warn "Образ НЕ пересобран — сейчас работает предыдущая версия."
  warn "Посмотри значения выше в .env, затем запусти снова:  ./install.sh"
  exit 0
fi

BOT_TOKEN_VALUE="$(env_value BOT_TOKEN)"
[[ -n "$BOT_TOKEN_VALUE" ]] || die "В .env пусто значение BOT_TOKEN"
[[ "$BOT_TOKEN_VALUE" == 123456:AA* ]] && die "BOT_TOKEN остался плейсхолдером из шаблона — вставь настоящий из @BotFather"
[[ "$BOT_TOKEN_VALUE" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] \
  || die "BOT_TOKEN не похож на токен Telegram (найдено: $(mask "$BOT_TOKEN_VALUE")). Формат: 1234567890:AA..."

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

say "Конфигурация проверена"
printf '    бот      %s\n' "$(mask "$BOT_TOKEN_VALUE")"
printf '    панель   %s\n' "$(mask "$PANEL_TOKEN_VALUE")"
printf '    AI       %s\n' "${AI_MODE_VALUE:-suggest}"

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

say "Собираю образ"
docker compose build

say "Предполётная проверка"
docker compose run --rm ai-support node dist/cli/selfcheck.js || die "Проверка не прошла — смотри вывод выше"

say "Запускаю"
docker compose up -d

say "Готово"
docker compose ps
printf '\nПанель: http://127.0.0.1:%s\n' "$(grep -oP '^PANEL_PORT=\K.*' .env || echo 8080)"
printf 'Токен:  grep PANEL_TOKEN .env\n'
printf 'Логи:   docker compose logs -f\n\n'
