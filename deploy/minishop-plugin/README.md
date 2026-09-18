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
  -t minishop-backend-ai-support:latest \
  .
```

По умолчанию основой служит официальный
`docker.io/3252a8/remnawave-minishop-backend:latest`. Для закрепления версии:

```bash
docker build \
  --build-arg MINISHOP_BACKEND_IMAGE=docker.io/3252a8/remnawave-minishop-backend:3.6.1 \
  -f deploy/minishop-plugin/Dockerfile \
  -t minishop-backend-ai-support:3.6.1 \
  .
```

## Подключение к MiniShop

Скопируйте `docker-compose.override.example.yml` в каталог MiniShop, добавьте в
его `.env` два значения и перезапустите только backend:

```ini
MINISHOP_AI_SUPPORT_TOKEN=<случайная строка не короче 24 символов>
MINISHOP_AI_SUPPORT_ADMIN_TELEGRAM_ID=<Telegram ID администратора MiniShop>
```

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --no-build backend
docker compose -f docker-compose.yml -f docker-compose.override.yml logs -f backend
```

Администратор с указанным Telegram ID должен хотя бы раз войти в MiniShop,
чтобы существовать в его базе. Если отдельный ID не задан, плагин берёт первый
из `ADMIN_IDS`.

Проверка API:

```bash
curl -fsS \
  -H "X-API-Key: $MINISHOP_AI_SUPPORT_TOKEN" \
  https://shop.example.com/api/plugins/ai-support/v1/health
```

В `.env` AI Support укажите тот же токен и внешний HTTPS URL MiniShop:

```ini
MINISHOP_ENABLED=true
MINISHOP_NAME=MiniShop
MINISHOP_API_URL=https://shop.example.com
MINISHOP_API_TOKEN=<тот же токен>
MINISHOP_API_MODE=plugin
MINISHOP_POLL_SECONDS=30
```

Режим `admin` принимает временный AdminBearer штатной админки без установки
плагина, но после истечения сессии его придётся заменять вручную.
