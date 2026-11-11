# AI Support

[![Версия](https://img.shields.io/github/v/release/tagashi666/ai-support?label=версия)](https://github.com/tagashi666/ai-support/releases/latest)
[![CI](https://github.com/tagashi666/ai-support/actions/workflows/ci.yml/badge.svg)](https://github.com/tagashi666/ai-support/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-43853d)](https://nodejs.org/)
[![Лицензия MIT](https://img.shields.io/badge/лицензия-MIT-blue.svg)](LICENSE)
[![Чат в Telegram](https://img.shields.io/badge/Telegram-чат_проекта-26A5E4?logo=telegram&logoColor=white)](https://t.me/+FU-FMaOl3YE2NjYy)

Self-hosted центр поддержки для VPN-сервисов на Telegram, Bedolaga, Remnawave
и MiniShop. Одна панель для компьютера и телефона: кто ждёт ответа, диалог с
карточкой клиента, AI-помощник с базой знаний, команда, отчёты и состояние
системы. Приложение запускается без подключённых каналов — их можно добавлять
по мере готовности.

## Возможности

- единая очередь Telegram Business, Telegram-ботов, Bedolaga и MiniShop;
- двусторонние ответы и статусы внешних тикетов;
- изображения и вложения с локальным защищённым хранением;
- карточка клиента из Bedolaga, MiniShop, Remnawave и собственного Support API;
- роли, назначения, присутствие операторов и журнал аудита;
- SLA, аналитика и уведомления в Telegram;
- AI-черновики и автоответы с базой знаний и защитой от утечки секретов;
- живой ответ в Telegram-боте: индикатор «печатает…» и текст, который
  появляется по мере набора;
- ссылки для клиентов (прокси, бот, сайт): AI вставляет их сам, а точный адрес
  подставляет сервер;
- обучение на закрытых диалогах: черновики статей для базы знаний;
- мастер установки и диагностика `./install.sh --setup` / `--check`;
- панель 3.0 для компьютера и телефона: список «кому нужен ответ», который
  не скачет; изменения коллег видны за доли секунды; работа вдвоём над одним
  диалогом; раскладка на всю ширину — от телефона до 2K-монитора;
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

Одна команда — скачать последний
[GitHub Release](https://github.com/tagashi666/ai-support/releases/latest) и
запустить установщик:

```bash
mkdir -p /root/ai-support && cd /root/ai-support \
  && curl -fL https://github.com/tagashi666/ai-support/releases/latest/download/ai-support.tar.gz \
  | tar xz --strip-components=1 && ./install.sh
```

Либо клонируйте `main` (`git clone https://github.com/tagashi666/ai-support.git`)
и запустите `./install.sh` в каталоге проекта.

При первом запуске установщик соберёт образ и откроет **мастер настройки**.
Мастер работает внутри контейнера — из той же сети, что и бот, — и по шагам
спрашивает:

1. токен бота (проверит через Telegram и покажет @username) и чат для
   уведомлений — найдёт его сам, если написать боту или в группу с ним;
2. AI-провайдера, ключ и модель из списка провайдера (можно пропустить);
3. порт панели на сервере (покажет, кем занят порт, и предложит свободный) и
   способ доступа: SSH-туннель, Cloudflare Tunnel или свой домен;
4. Bedolaga и Remnawave (необязательно) — с проверкой DNS, порта и токена и
   понятным объяснением, если что-то не так.

Потом он запишет `.env` (бэкап старого — рядом), поднимет контейнер, дождётся
healthcheck и напечатает, как открыть панель. Повторная настройка —
`./install.sh --setup`, проверка «почему не работает» — `./install.sh --check`
(ничего не меняет). Обновление существующей установки — просто `./install.sh`,
без вопросов. При запуске от root установщик ещё ставит ограниченные
обработчики обновлений и новых источников.

### Минимальная настройка

Мастер заполняет это сам; вручную — в `.env` нужны только пять строк (остальное работает по умолчанию из кода,
полный список с описаниями — в [`.env.example`](.env.example)):

```dotenv
PANEL_TOKEN=<ГЕНЕРИРУЕТ_install.sh>
BOT_TOKEN=<ТОКЕН_ИЗ_BOTFATHER>
AI_API_KEY=<КЛЮЧ_ПРОВАЙДЕРА>
ALERT_CHAT_ID=<ID_ЧАТА_ДЛЯ_УВЕДОМЛЕНИЙ>
PANEL_URL=https://support.example.com
```

`PANEL_URL` — внешний адрес этой панели, а не Remnawave. Для каждой
интеграции добавьте `*_ENABLED=true`, URL и токен. Часть настроек AI
(`AI_MODE`, `AI_MODEL`, `NOTIFY_LEVEL` и др.) можно менять в панели: после
первого сохранения там значение из панели главнее значения в `.env`.
При обновлении `install.sh` не дописывает необязательные ключи в `.env`.

Порт панели на сервере — `PANEL_PUBLISH_PORT` (по умолчанию 8080, только
127.0.0.1). `PANEL_PORT`/`PANEL_HOST` в Docker не трогайте.

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
BEDOLAGA_POLL_SECONDS=20
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

MiniShop также можно добавить через **Подключения → Подключить канал или источник**. Это работает,
если `install.sh` запускался от root. Иначе один раз установите обработчик:

```bash
sudo bash scripts/install-host-updater.sh "$(pwd)"
```

## Telegram и AI

Telegram-бот и Business Mode настраиваются через `.env` и мастер источников в
панели. Для Business-аккаунта включите **@BotFather → Bot Settings → Business
Mode**, затем выдайте боту только права ответа и отметки прочтения.

Пока `AI_API_KEY` не задан, AI выключен; с ключом по умолчанию включается режим
черновиков `suggest` (оператор отправляет ответ сам). `AI_MODE` можно задать
явно или изменить в панели:

```dotenv
AI_MODE=suggest
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=<КЛЮЧ_ПРОВАЙДЕРА>
AI_MODEL=qwen/qwen3.8-27b
AI_MODEL_FALLBACK=openai/gpt-oss-120b
AI_VISION_MODELS=qwen/qwen3.8-27b
```

Как отвечает AI:

- **Только по фактам.** Опора — выдержки из базы знаний, карточка клиента
  (трафик, срок, устройства — уже посчитанные) и состояние серверов. Нет
  опоры — вопрос уходит оператору, клиент получает сообщение о передаче.
- **Уточняет, а не гадает.** На «не работает VPN» AI спросит устройство и
  приложение, а не перечислит общие советы.
- **Не мешает человеку.** После ответа оператора AI на паузе (готовит только
  черновики), закрытие диалога паузу снимает.
- **Не выдаёт внутреннее.** Перед отправкой каждый ответ проверяется: IP,
  домены, ключи, ссылки подписки и упоминания «базы знаний» клиенту не уходят.
- **Не падает на одной модели.** Ошибка основной модели — запрос уходит на
  запасную (`AI_MODEL_FALLBACK`).
- **Экономит токены.** База знаний подаётся лучшими кусками в общем бюджете
  (`AI_KB_BUDGET_CHARS`), расход по моделям виден в статистике.

Ссылки, которые AI может давать сам (прокси для Telegram, бот, сайт),
заводятся в **Помощник → Как общается → Ссылки для клиентов**: ключ, название, адрес и
«когда давать». В комплекте базы знаний есть статья о разнице между прокси для
Telegram и VPN.

Качество ответов на своей модели можно проверить прогоном
`docker compose run --rm ai-support node dist/cli/aieval.js` (около 40
запросов к провайдеру).

Режим `auto` включайте только после проверки базы знаний и фильтров на реальных
диалогах. Подробнее — в [`PROVIDERS.md`](PROVIDERS.md) и
[`SECURITY.md`](SECURITY.md).

## Панель

По адресу панели открывается панель 3.0. Вход — по `PANEL_TOKEN` или по личному
ключу, который владелец выдаёт в «Команде».

- **Сегодня** — кто ждёт ответа, что сделал помощник, неполадки и первые шаги
  для новой установки.
- **Диалоги** — список по секциям («Ждут вас», «Ведут коллеги», «Помощник
  ведёт», «Ждём клиента», «Решённые»), лента с ответом, заметкой для команды и
  черновиком помощника, карточка клиента с подпиской и устройствами. На широком
  экране карточка клиента закреплена справа.
- **Знания** — статьи, идеи из закрытых диалогов, шаблоны и подсказки по
  кабинету.
- **Помощник** — режим (выключен, наблюдает, подсказывает, отвечает сам),
  пауза, что он делал и почему, ссылки для клиентов.
- **Отчёты**, **Подключения**, **Команда** (люди, роли и права словами,
  журнал), **Система** (здоровье, серверы, обновление и откат, уведомления),
  **Это устройство** (тема, клавиши, звук, уведомления браузера).

Поиск и команды — `Ctrl+K` / `⌘K`, список клавиш — `?`. Навигация — боковая
панель на компьютере и вкладки снизу на телефоне; тема светлая, тёмная или как
в системе.

Классическая панель пока остаётся в сборке как запасная:

- на своём устройстве — «Классическая панель» в меню аккаунта (внизу
  навигации, на телефоне — в «Ещё») или адрес `/?ui=classic`; обратно — «Попробовать
  новую панель» в классической или `/?ui=next`. Выбор запоминается в браузере;
- для всей установки — «Система → Панель» или переменная `PANEL_UI=classic`
  в `.env` (она сильнее настройки в панели, после правки — перезапуск).

Ссылки на диалог из уведомлений в Telegram (`/#c<id>`) и старые адреса
разделов классики (`/#v=<раздел>`) открывают тот же диалог или раздел в той
панели, которая выбрана.

## Эксплуатация

```bash
docker compose ps
docker compose logs -f ai-support
docker compose up -d --build
docker compose run --rm ai-support node dist/cli/selfcheck.js
```

Данные находятся в `data/`, опубликованная база знаний — в `kb/`, секреты — в
`.env`. Не добавляйте эти файлы, пользовательские медиа и резервные копии в Git.

При установке от root обновления доступны в панели: **Система → Обновление**.
Updater скачивает точный GitHub Release, проверяет SHA-256 и состав архива, делает backup и откатывается
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
npm run test:e2e       # Playwright: Chromium, WebKit, Firefox на синтетической базе
npm run dev:web        # сборка панели с горячей перезагрузкой
```

Живой стенд на синтетических данных (без `.env` и каналов):
`npx vite build --config web/vite.config.ts && PANEL_PORT=8195 npx tsx scripts/devlive.ts`,
затем `http://127.0.0.1:8195/next/?live=1`. `DEVSEED_HEAVY=1` — 500 диалогов и лента
на 1000 сообщений для замеров. Скриншоты для приёмки — `scripts/shots.mjs`,
замер плавности с замедленным CPU — `scripts/perfprobe.mjs`.

## Документация

- [`DEPLOY.md`](DEPLOY.md) — production-развёртывание и диагностика;
- [`SECURITY.md`](SECURITY.md) — модель угроз и защитные слои;
- [`PROVIDERS.md`](PROVIDERS.md) — AI-провайдеры и модели;
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — устройство приложения;
- [`CHANGELOG.md`](CHANGELOG.md) — изменения по версиям;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — участие в разработке.

## Сообщество

Вопросы по установке, идеи и обсуждение — в
[чате проекта в Telegram](https://t.me/+FU-FMaOl3YE2NjYy). Ошибки и
предложения с кодом — в [Issues](https://github.com/tagashi666/ai-support/issues).

## Лицензия

[MIT](LICENSE).
