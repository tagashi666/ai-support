# Companion-плагин AI Support для MiniShop

Штатный AdminBearer MiniShop привязан к Web App-сессии и истекает, поэтому для
постоянной серверной интеграции этот каталог собирает официальный backend с
небольшим Plugin API v1 расширением. Оно добавляет только namespace
`/api/plugins/ai-support/v1` и проверяет `X-API-Key`.

## Сборка

Из корня AI Support:

```bash
docker build \
  -f deploy/minishop-plugin/Dockerfile \
  -t minishop-backend-ai-support:3.7.1 \
  .
```

По умолчанию основой служит проверенный официальный образ MiniShop `3.7.1`.
Версия companion-backend должна совпадать с `IMAGE_TAG` установленного
MiniShop: нельзя смешивать новый backend со старыми worker и frontend.

Для MiniShop `3.7.1`:

```bash
docker build \
  --build-arg MINISHOP_BACKEND_IMAGE=docker.io/3252a8/remnawave-minishop-backend:3.7.1 \
  -f deploy/minishop-plugin/Dockerfile \
  -t minishop-backend-ai-support:3.7.1 \
  .
```

Для другой версии замените `3.7.1` в обоих местах на точное значение
`IMAGE_TAG` MiniShop и задайте в `.env` MiniShop:

```ini
MINISHOP_AI_SUPPORT_IMAGE=minishop-backend-ai-support:<IMAGE_TAG>
```

## Подключение к MiniShop

Скопируйте `docker-compose.override.example.yml` в каталог MiniShop, добавьте в
его `.env` значения ниже и перезапустите только backend:

```ini
MINISHOP_AI_SUPPORT_TOKEN=<случайная строка не короче 24 символов>
MINISHOP_AI_SUPPORT_ADMIN_TELEGRAM_ID=<Telegram ID администратора MiniShop>
MINISHOP_AI_SUPPORT_IMAGE=minishop-backend-ai-support:3.7.1
```

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --no-build backend
docker compose -f docker-compose.yml -f docker-compose.override.yml logs -f backend
```

Администратор с указанным Telegram ID должен хотя бы раз войти в MiniShop,
чтобы существовать в его базе. Если отдельный ID не задан, плагин берёт первый
из `ADMIN_IDS`.

Если health отвечает `admin_unavailable`, сначала войдите этим администратором
в MiniShop и повторите проверку. Это означает, что плагин загружен, но ещё не
может подписывать ответы существующим пользователем MiniShop.

Проверка API:

```bash
curl -fsS \
  -H "X-API-Key: $MINISHOP_AI_SUPPORT_TOKEN" \
  "$WEBHOOK_BASE_URL/api/plugins/ai-support/v1/health"
```

Плагин регистрирует маршрут на обеих HTTP-плоскостях MiniShop: webhook/backend
`8080` и WebApp API `8081`. Поэтому `MINISHOP_API_URL` может быть как
`WEBHOOK_BASE_URL`, так и публичным `SUBSCRIPTION_MINI_APP_URL`. Для
server-to-server подключения предпочтительнее `WEBHOOK_BASE_URL`: запрос идёт
прямо в backend и не зависит от frontend proxy.

В `.env` AI Support укажите тот же токен и внешний HTTPS URL MiniShop:

```ini
MINISHOP_ENABLED=true
MINISHOP_NAME=MiniShop
MINISHOP_API_URL=https://webhooks.example.com
MINISHOP_API_TOKEN=<тот же токен>
MINISHOP_API_MODE=plugin
MINISHOP_POLL_SECONDS=30
```

Режим `admin` принимает временный AdminBearer штатной админки без установки
плагина, но после истечения сессии его придётся заменять вручную.
