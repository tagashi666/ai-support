# AI Support

[![Версия](https://img.shields.io/github/v/release/tagashi666/ai-support?label=версия)](https://github.com/tagashi666/ai-support/releases/latest)
[![CI](https://github.com/tagashi666/ai-support/actions/workflows/ci.yml/badge.svg)](https://github.com/tagashi666/ai-support/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-43853d)](https://nodejs.org/)
[![Лицензия MIT](https://img.shields.io/badge/лицензия-MIT-blue.svg)](LICENSE)

Self-hosted центр поддержки для Telegram, Bedolaga и MiniShop. В одной панели
собраны обращения, операторы, SLA, шаблоны, база знаний, статистика и
AI-помощник. Приложение можно запустить без подключённых каналов и добавлять их
по мере готовности.

## Возможности

- единая очередь Telegram Business, Telegram-ботов, Bedolaga и MiniShop;
- двусторонние ответы и статусы внешних тикетов;
- изображения и вложения с локальным защищённым хранением;
- карточка клиента из Bedolaga, MiniShop, Remnawave и собственного Support API;
- роли, назначения, присутствие операторов и журнал аудита;
- SLA, аналитика и уведомления в Telegram;
- AI-черновики и автоответы с базой знаний и защитой от утечки секретов;
- безопасное обновление и откат из панели.

| Канал | Входящие | Ответы | Медиа | Статусы |
| --- | --- | --- | --- | --- |
| Telegram Business | Да | Да | Да | Прочтение |
| Telegram-бот | Да | Да | Да | Прочтение |
| Bedolaga | Да | Текст | Входящие | В обе стороны |
| MiniShop | Да | Текст и изображения | Да | В обе стороны |

## Требования

- Ubuntu 22.04+, Debian 12+ или другой современный Linux;
- Docker Engine 24+ и Docker Compose v2;
- `openssl`;
- от 512 МБ свободной памяти и 2 ГБ диска;
- HTTPS reverse proxy для доступа к панели из интернета.

Контейнер собирается локально из текущего релиза. Готовый публичный Docker-
образ проект не публикует.

## Быстрый запуск

Рекомендуемый способ — установить последний
[GitHub Release](https://github.com/tagashi666/ai-support/releases/latest):

```bash
mkdir -p /root/ai-support
cd /root/ai-support
curl -fL -o ai-support.tar.gz \
  https://github.com/tagashi666/ai-support/releases/latest/download/ai-support.tar.gz
tar xzf ai-support.tar.gz --strip-components=1
./install.sh
```

Либо клонируйте `main`:

```bash
git clone https://github.com/tagashi666/ai-support.git
cd ai-support
./install.sh
```

При первом запуске установщик:

1. создаст `.env` и сгенерирует `PANEL_TOKEN`;
2. подготовит каталоги данных;
3. соберёт Docker-образ и выполнит self-check;
4. запустит панель на `127.0.0.1:8080`;
5. при запуске от root установит ограниченные обработчики обновлений и новых
   источников.

Пустые токены каналов допустимы. Откройте `http://127.0.0.1:8080`, войдите с
`PANEL_TOKEN` из `.env`, затем подключайте нужные источники.

Для production поставьте reverse proxy с TLS. Готовый конфиг nginx находится в
[`deploy/ai-support.conf`](deploy/ai-support.conf), полная инструкция — в
[`DEPLOY.md`](DEPLOY.md).

## Подключение Bedolaga

Нужны адрес Web API бота и его ключ. Ключ передаётся в `X-API-Key` и должен
иметь доступ к тикетам, сообщениям, пользователям и FAQ.

Добавьте в `.env`:

```dotenv
BEDOLAGA_ENABLED=true
BEDOLAGA_API_URL=https://bot.example.com/api
BEDOLAGA_API_TOKEN=<WEBAPI_KEY>
BEDOLAGA_POLL_SECONDS=60
BEDOLAGA_FAQ_LANGUAGE=ru
```

Проверьте соединение и перезапустите приложение:

```bash
docker compose run --rm ai-support node dist/cli/selfcheck.js
docker compose up -d
docker compose logs -f ai-support
```

Первый опрос импортирует активные тикеты как историю: AI и SLA не реагируют на
старые сообщения. После этого новые обращения и изменения статуса
синхронизируются в обе стороны.

Ограничения Bedolaga:

- исходящий ответ поддерживает только текст, входящие вложения отображаются;
- endpoint ответа неидемпотентен, поэтому после таймаута нужно проверить тикет
  перед ручной повторной отправкой.

## Подключение MiniShop

Для постоянной серверной интеграции используется companion-плагин. Временный
`AdminBearer` штатной админки подходит только для диагностики.

### 1. Соберите backend MiniShop с плагином

В корне AI Support:

```bash
docker build \
  -f deploy/minishop-plugin/Dockerfile \
  -t minishop-backend-ai-support:3.7.1 \
  .
```

По умолчанию Dockerfile закреплён на проверенном MiniShop `3.7.1`. Версия
companion-backend должна совпадать с `IMAGE_TAG` установленного MiniShop. Для
другой версии укажите её явно и в базовом, и в результирующем образе:

```bash
docker build \
  --build-arg MINISHOP_BACKEND_IMAGE=docker.io/3252a8/remnawave-minishop-backend:<VERSION> \
  -f deploy/minishop-plugin/Dockerfile \
  -t minishop-backend-ai-support:<VERSION> \
  .
```

### 2. Подключите образ в MiniShop

Скопируйте
[`deploy/minishop-plugin/docker-compose.override.example.yml`](deploy/minishop-plugin/docker-compose.override.example.yml)
в каталог MiniShop как `docker-compose.override.yml`. В `.env` MiniShop
добавьте:

```dotenv
MINISHOP_AI_SUPPORT_TOKEN=<СЛУЧАЙНАЯ_СТРОКА_НЕ_КОРОЧЕ_24_СИМВОЛОВ>
MINISHOP_AI_SUPPORT_ADMIN_TELEGRAM_ID=<TELEGRAM_ID_АДМИНИСТРАТОРА>
MINISHOP_AI_SUPPORT_IMAGE=minishop-backend-ai-support:3.7.1
```

Администратор должен хотя бы раз войти в MiniShop. Если отдельный ID не задан,
плагин использует первого администратора из `ADMIN_IDS`.

Перезапустите backend MiniShop:

```bash
docker compose up -d --no-build backend
docker compose logs -f backend
```

Проверьте API:

```bash
curl -fsS \
  -H "X-API-Key: $MINISHOP_AI_SUPPORT_TOKEN" \
  "$WEBHOOK_BASE_URL/api/plugins/ai-support/v1/health"
```

### 3. Настройте AI Support

Добавьте в `.env` AI Support тот же service token:

```dotenv
MINISHOP_ENABLED=true
MINISHOP_NAME=MiniShop
MINISHOP_API_URL=https://webhooks.example.com
MINISHOP_API_TOKEN=<ТОТ_ЖЕ_SERVICE_TOKEN>
MINISHOP_API_MODE=plugin
MINISHOP_POLL_SECONDS=30
```

`MINISHOP_API_URL` — публичный `WEBHOOK_BASE_URL` MiniShop без обязательного
`/api`. Плагин также доступен через `SUBSCRIPTION_MINI_APP_URL`, но backend URL
предпочтительнее: он не зависит от frontend proxy. Клиент нормализует оба
варианта пути.

```bash
docker compose run --rm ai-support node dist/cli/selfcheck.js
docker compose up -d
docker compose logs -f ai-support
```

Первый опрос импортирует активные тикеты как историю. Затем текст,
изображения, прочтение, приоритет и статусы синхронизируются в обе стороны.
Подробности плагина — в
[`deploy/minishop-plugin/README.md`](deploy/minishop-plugin/README.md).

MiniShop также можно добавить через **Настройки → Источники**. Это работает,
если `install.sh` запускался от root. Иначе один раз установите обработчик:

```bash
sudo bash scripts/install-host-updater.sh "$(pwd)"
```

## Telegram и AI

Telegram-бот и Business Mode настраиваются через `.env` и мастер источников в
панели. Для Business-аккаунта включите **@BotFather → Bot Settings → Business
Mode**, затем выдайте боту только права ответа и отметки прочтения.

AI по умолчанию выключен. Начинайте с режима черновиков:

```dotenv
AI_MODE=suggest
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=<КЛЮЧ_ПРОВАЙДЕРА>
AI_MODEL=qwen/qwen3.8-27b
AI_MODEL_FALLBACK=openai/gpt-oss-120b
AI_VISION_MODELS=qwen/qwen3.8-27b
```

Режим `auto` включайте только после проверки базы знаний и фильтров на реальных
диалогах. Подробнее — в [`PROVIDERS.md`](PROVIDERS.md) и
[`SECURITY.md`](SECURITY.md).

## Эксплуатация

```bash
docker compose ps
docker compose logs -f ai-support
docker compose up -d --build
docker compose run --rm ai-support node dist/cli/selfcheck.js
```

Данные находятся в `data/`, опубликованная база знаний — в `kb/`, секреты — в
`.env`. Не добавляйте эти файлы, пользовательские медиа и резервные копии в Git.

При установке от root обновления доступны из панели. Updater скачивает точный
GitHub Release, проверяет SHA-256 и состав архива, делает backup и откатывается
при неуспешном health-check.

Панель намеренно слушает только `127.0.0.1`. Не меняйте публикацию Docker-порта
на `0.0.0.0` и не передавайте контейнеру `/var/run/docker.sock`.

## Разработка

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run release:check
```

## Документация

- [`DEPLOY.md`](DEPLOY.md) — production-развёртывание и диагностика;
- [`SECURITY.md`](SECURITY.md) — модель угроз и защитные слои;
- [`PROVIDERS.md`](PROVIDERS.md) — AI-провайдеры и модели;
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — устройство приложения;
- [`CHANGELOG.md`](CHANGELOG.md) — изменения по версиям;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — участие в разработке.

## Лицензия

[MIT](LICENSE).
