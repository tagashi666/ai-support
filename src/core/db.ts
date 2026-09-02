import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, log } from '../config.js';

/**
 * Миграции применяются по порядку, версия хранится в PRAGMA user_version.
 * Добавляя новую — только дописывай в конец массива, никогда не правь существующие.
 */
const MIGRATIONS: string[] = [
  // 001 — базовая схема
  `
  CREATE TABLE conversation (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    channel                TEXT    NOT NULL,
    external_id            TEXT    NOT NULL,
    tg_user_id             INTEGER,
    business_connection_id TEXT,
    username               TEXT,
    display_name           TEXT,
    status                 TEXT    NOT NULL DEFAULT 'open',
    priority               TEXT    NOT NULL DEFAULT 'normal',
    assignee               TEXT,
    ai_mode                TEXT    NOT NULL DEFAULT 'suggest',
    last_inbound_at        INTEGER,
    last_message_at        INTEGER,
    unread                 INTEGER NOT NULL DEFAULT 0,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL,
    UNIQUE (channel, external_id)
  );
  CREATE INDEX idx_conversation_activity ON conversation (last_message_at DESC);
  CREATE INDEX idx_conversation_tg_user  ON conversation (tg_user_id);

  CREATE TABLE message (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    direction       TEXT    NOT NULL,
    author          TEXT    NOT NULL,
    text            TEXT,
    media_type      TEXT,
    media_file_id   TEXT,
    external_msg_id TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_message_conversation ON message (conversation_id, id);
  CREATE UNIQUE INDEX idx_message_external
    ON message (conversation_id, external_msg_id)
    WHERE external_msg_id IS NOT NULL;

  CREATE TABLE business_connection (
    id           TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    user_chat_id INTEGER,
    is_enabled   INTEGER NOT NULL,
    rights       TEXT,
    connected_at INTEGER,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE customer (
    tg_user_id  INTEGER PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    last_name   TEXT,
    snapshot    TEXT,
    snapshot_at INTEGER,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE event (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL,
    conversation_id INTEGER,
    payload         TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_event_created ON event (created_at DESC);
  `,

  // 002 — индекс идемпотентности только для входящих.
  // Раньше он накрывал и исходящие: Telegram и бедолага нумеруют сообщения
  // независимо, поэтому наш ответ мог совпасть по id с входящим и упасть
  // уже ПОСЛЕ фактической отправки — худший из возможных отказов.
  `
  DROP INDEX idx_message_external;
  CREATE UNIQUE INDEX idx_message_external
    ON message (conversation_id, external_msg_id)
    WHERE external_msg_id IS NOT NULL AND direction = 'in';
  `,

  // 003 — AI, база знаний, шаблоны, SLA, вложения, курсоры поллинга.
  `
  ALTER TABLE conversation ADD COLUMN subject           TEXT;
  ALTER TABLE conversation ADD COLUMN first_response_at INTEGER;
  ALTER TABLE conversation ADD COLUMN resolved_at       INTEGER;
  ALTER TABLE conversation ADD COLUMN escalated         INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversation ADD COLUMN last_ai_at        INTEGER;

  ALTER TABLE message ADD COLUMN suggestion_id INTEGER;

  CREATE TABLE ai_suggestion (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    message_id      INTEGER,
    text            TEXT    NOT NULL,
    confidence      REAL,
    needs_human     INTEGER NOT NULL DEFAULT 0,
    reason          TEXT,
    model           TEXT,
    sources         TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending',
    decided_at      INTEGER,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_suggestion_conversation ON ai_suggestion (conversation_id, id DESC);
  CREATE INDEX idx_suggestion_status       ON ai_suggestion (status, created_at DESC);

  CREATE TABLE kb_doc (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    ext_id     TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, ext_id)
  );
  CREATE VIRTUAL TABLE kb_fts USING fts5(
    title, body, content='kb_doc', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE template (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcut   TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    uses       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE attachment (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    media_type      TEXT,
    file_ref        TEXT NOT NULL,
    local_path      TEXT,
    bytes           INTEGER,
    downloaded_at   INTEGER,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_attachment_message ON attachment (message_id);

  CREATE TABLE poll_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  // 004 — режим AI по умолчанию наследуется от глобального.
  // Раньше каждый диалог жёстко вставал в 'suggest', и переключение
  // AI_MODE=auto в окружении не давало никакого эффекта: настройка была
  // видна в логах, но не работала ни в одном диалоге.
  `
  UPDATE conversation SET ai_mode = 'inherit' WHERE ai_mode = 'suggest';
  `,

  // 005 — корректная метрика первого ответа и счётчик попыток скачивания.
  // Раньше время считалось как first_response_at - last_inbound_at, где
  // last_inbound_at — это ПОСЛЕДНЕЕ входящее. После второго сообщения клиента
  // разность уходила в минус и строка выпадала из выборки: метрика показывала
  // null на любых живых данных.
  `
  ALTER TABLE conversation ADD COLUMN first_inbound_at INTEGER;
  ALTER TABLE attachment   ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

  UPDATE conversation SET first_inbound_at = (
    SELECT MIN(created_at) FROM message
     WHERE message.conversation_id = conversation.id AND message.direction = 'in'
  );
  `,

  // 006 — настройки, правимые из панели, и журнал фоновых задач.
  `
  CREATE TABLE setting (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE job (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'running',
    progress   TEXT,
    result     TEXT,
    error      TEXT,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );
  CREATE INDEX idx_job_started ON job (started_at DESC);
  `,

  // 007 — передача диалога человеку как явное состояние.
  // Раньше AI просто молчал: клиент не знал, что его вопрос передали,
  // а на следующее сообщение модель снова принималась отвечать.
  `
  ALTER TABLE conversation ADD COLUMN handoff_at          INTEGER;
  ALTER TABLE conversation ADD COLUMN handoff_notified_at INTEGER;
  `,

  // 008 — ответы на конкретные сообщения. В Telegram это половина смысла
  // переписки: без цитаты «Да» и «Вот что выходит» повисают в воздухе.
  `
  ALTER TABLE message ADD COLUMN reply_to_external_id TEXT;
  ALTER TABLE message ADD COLUMN reply_excerpt        TEXT;
  `,

  // 009 — клиент не найден ни в одной базе. Это не эскалация: вопрос может
  // быть простым, но отвечать вслепую тому, кого нет в системе, опасно —
  // так выглядят и чужие люди, и попытки выманить чужую подписку.
  `
  ALTER TABLE conversation ADD COLUMN suspicious INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversation ADD COLUMN sub_link   TEXT;
  `,

  // 010 — размеры картинки. Без них место под вложение не зарезервировано:
  // фотография догружается, меняет высоту и толкает всю переписку вниз.
  // Именно это выглядит как дёрганье при открытии диалога.
  `
  ALTER TABLE attachment ADD COLUMN width  INTEGER;
  ALTER TABLE attachment ADD COLUMN height INTEGER;
  `,

  // 011 — профиль Telegram и атомарная передача диалога оператору.
  // avatar_file_id хранит только Telegram file_id, сам файл по-прежнему
  // отдаётся через авторизованную панель. operator_active_at закрывает гонку:
  // AI видит оператора ещё до того, как внешний API подтвердил его ответ.
  `
  ALTER TABLE conversation ADD COLUMN avatar_file_id    TEXT;
  ALTER TABLE conversation ADD COLUMN operator_active_at INTEGER;
  `,

  // 012 — операционная модель 2.0: несколько операторов, единый клиент,
  // аудит, SLA, управляемое обучение AI и сохранённые представления.
  // Токены операторов хранятся только в виде SHA-256; plaintext выдаётся
  // ровно один раз при создании или ротации учётной записи.
  `
  CREATE TABLE operator_account (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    role       TEXT    NOT NULL CHECK (role IN ('admin','lead','agent','viewer')),
    token_hash TEXT    NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  ALTER TABLE conversation ADD COLUMN assigned_operator_id INTEGER REFERENCES operator_account(id);
  ALTER TABLE conversation ADD COLUMN claimed_at            INTEGER;

  CREATE TABLE operator_presence (
    actor_key       TEXT    NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    state           TEXT    NOT NULL CHECK (state IN ('viewing','typing')),
    seen_at         INTEGER NOT NULL,
    PRIMARY KEY (actor_key, conversation_id)
  );
  CREATE INDEX idx_operator_presence_seen ON operator_presence (conversation_id, seen_at DESC);

  CREATE TABLE customer_profile (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT    NOT NULL UNIQUE,
    tg_user_id   INTEGER,
    username     TEXT,
    display_name TEXT,
    email        TEXT,
    phone        TEXT,
    company      TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_customer_profile_tg ON customer_profile (tg_user_id);
  CREATE INDEX idx_customer_profile_username ON customer_profile (username);

  ALTER TABLE conversation ADD COLUMN customer_profile_id INTEGER REFERENCES customer_profile(id);

  INSERT OR IGNORE INTO customer_profile
    (identity_key, tg_user_id, username, display_name, created_at, updated_at)
  SELECT CASE WHEN tg_user_id IS NOT NULL THEN 'tg:' || tg_user_id
              ELSE channel || ':' || external_id END,
         tg_user_id, username, display_name, created_at, updated_at
    FROM conversation;
  UPDATE conversation
     SET customer_profile_id = (
       SELECT id FROM customer_profile
        WHERE identity_key = CASE WHEN conversation.tg_user_id IS NOT NULL
          THEN 'tg:' || conversation.tg_user_id
          ELSE conversation.channel || ':' || conversation.external_id END
     );

  CREATE TABLE customer_tag (
    customer_id INTEGER NOT NULL REFERENCES customer_profile(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (customer_id, tag)
  );
  CREATE TABLE customer_note (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customer_profile(id) ON DELETE CASCADE,
    actor_key   TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_key   TEXT    NOT NULL,
    actor_name  TEXT    NOT NULL,
    actor_role  TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    resource    TEXT    NOT NULL,
    resource_id TEXT,
    payload     TEXT,
    ip          TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
  CREATE INDEX idx_audit_resource ON audit_log (resource, resource_id, created_at DESC);

  CREATE TABLE kb_candidate (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    file_name    TEXT    NOT NULL,
    source       TEXT    NOT NULL,
    confidence   REAL,
    status       TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected')),
    version      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    decided_at   INTEGER,
    decided_by   TEXT,
    UNIQUE (file_name, version)
  );
  CREATE INDEX idx_kb_candidate_status ON kb_candidate (status, created_at DESC);

  CREATE TABLE sla_policy (
    priority               TEXT PRIMARY KEY,
    first_response_minutes INTEGER NOT NULL,
    resolution_minutes     INTEGER NOT NULL
  );
  INSERT INTO sla_policy VALUES ('low',    240, 2880);
  INSERT INTO sla_policy VALUES ('normal',  60, 1440);
  INSERT INTO sla_policy VALUES ('high',    20,  480);
  INSERT INTO sla_policy VALUES ('urgent',   5,  120);

  CREATE TABLE saved_filter (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key  TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    query      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_key, name)
  );

  CREATE TABLE update_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT    NOT NULL,
    version     TEXT,
    status      TEXT    NOT NULL,
    backup_path TEXT,
    detail      TEXT,
    actor_key   TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_update_history_created ON update_history (created_at DESC);
  `,

  // 013 — отделяем импортированную историю от живых обращений. История
  // нужна оператору в диалоге, но не должна раздувать SLA и статистику.
  `ALTER TABLE message ADD COLUMN is_backfill INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_message_live_inbound
    ON message (created_at, conversation_id)
    WHERE direction = 'in' AND is_backfill = 0;`,

  // 014 — несколько Telegram/Business/Remnawave источников и папки inbox.
  // external_id остаётся уникальным транспортным ключом для совместимости,
  // remote_external_id — настоящий id чата, source_id — конкретный аккаунт.
  `
  ALTER TABLE conversation ADD COLUMN remote_external_id TEXT;
  ALTER TABLE conversation ADD COLUMN source_id          TEXT;
  ALTER TABLE conversation ADD COLUMN avatar_source_id   TEXT;
  ALTER TABLE business_connection ADD COLUMN source_id   TEXT;
  ALTER TABLE business_connection ADD COLUMN display_name TEXT;
  ALTER TABLE business_connection ADD COLUMN username     TEXT;

  UPDATE conversation SET remote_external_id = external_id WHERE remote_external_id IS NULL;
  UPDATE conversation SET source_id = CASE channel
    WHEN 'tg_dm' THEN 'telegram-business:legacy'
    WHEN 'tg_bot' THEN 'telegram-default'
    WHEN 'bedolaga' THEN 'bedolaga-default'
    ELSE channel || '-default' END
    WHERE source_id IS NULL;
  UPDATE conversation SET avatar_source_id = 'telegram-default'
    WHERE channel IN ('tg_dm','tg_bot') AND avatar_source_id IS NULL;

  CREATE TABLE source_account (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    metadata   TEXT,
    updated_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO source_account VALUES
    ('telegram-default','telegram_bot','Telegram',1,NULL,0),
    ('telegram-business:legacy','telegram_business','Telegram Business',1,NULL,0),
    ('bedolaga-default','bedolaga','Bedolaga',1,NULL,0);

  CREATE TABLE conversation_source (
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    source_id       TEXT    NOT NULL REFERENCES source_account(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, source_id)
  );
  INSERT OR IGNORE INTO conversation_source (conversation_id, source_id)
    SELECT id, source_id FROM conversation WHERE source_id IS NOT NULL;
  CREATE INDEX idx_conversation_source_source ON conversation_source (source_id, conversation_id);

  CREATE TABLE inbox_folder (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    color      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE inbox_folder_source (
    folder_id INTEGER NOT NULL REFERENCES inbox_folder(id) ON DELETE CASCADE,
    source_id TEXT    NOT NULL REFERENCES source_account(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, source_id)
  );
  `,

  // 015 — исправление карточек Telegram Business, которые старый обработчик
  // перезаписывал данными владельца аккаунта. Старые строки message не
  // переворачиваем: sender id возле них раньше не сохранялся, поэтому среди
  // author=client могут быть и реальные сообщения клиента, и ручные ответы
  // поддержки. Автоматически менять их направление было бы потерей данных.
  `
  CREATE TEMP TABLE corrupted_business_conversation AS
    SELECT c.id, c.remote_external_id
      FROM conversation c
      JOIN business_connection b ON b.id = c.business_connection_id
     WHERE c.channel = 'tg_dm'
       AND c.tg_user_id = b.user_id
       AND c.remote_external_id IS NOT NULL
       AND c.remote_external_id != ''
       AND c.remote_external_id NOT GLOB '*[^0-9]*'
       AND CAST(c.remote_external_id AS INTEGER) > 0
       AND CAST(c.remote_external_id AS INTEGER) != b.user_id;

  INSERT OR IGNORE INTO customer_profile
    (identity_key, tg_user_id, username, display_name, created_at, updated_at)
  SELECT 'tg:' || CAST(x.remote_external_id AS INTEGER),
         CAST(x.remote_external_id AS INTEGER), NULL, NULL,
         c.created_at, c.updated_at
    FROM corrupted_business_conversation x
    JOIN conversation c ON c.id = x.id;

  UPDATE conversation
     SET tg_user_id = CAST(remote_external_id AS INTEGER),
         username = NULL,
         display_name = NULL,
         avatar_file_id = NULL,
         customer_profile_id = (
           SELECT p.id FROM customer_profile p
            WHERE p.identity_key = 'tg:' || CAST(conversation.remote_external_id AS INTEGER)
         )
   WHERE id IN (SELECT id FROM corrupted_business_conversation);

  DROP TABLE corrupted_business_conversation;
  `,

  // 016 — миграция 015 правильно отвязала карточку клиента от владельца
  // Telegram Business, но слишком агрессивно очистила имя. Единый профиль
  // уже содержал корректные данные собеседника, поэтому возвращаем их в
  // карточку. Заодно начинаем хранить Telegram sender id возле каждого
  // нового сообщения: следующие ремонты направления не должны опираться на
  // догадки по тексту и времени.
  `
  ALTER TABLE message ADD COLUMN sender_tg_user_id INTEGER;
  CREATE INDEX idx_message_sender_tg_user ON message (sender_tg_user_id, created_at);

  UPDATE conversation
     SET username = COALESCE(
           NULLIF(username, ''),
           (SELECT NULLIF(p.username, '') FROM customer_profile p
             WHERE p.id = conversation.customer_profile_id)
         ),
         display_name = COALESCE(
           NULLIF(display_name, ''),
           (SELECT NULLIF(p.display_name, '') FROM customer_profile p
             WHERE p.id = conversation.customer_profile_id)
         )
   WHERE channel IN ('tg_dm', 'tg_bot')
     AND customer_profile_id IS NOT NULL;
  `,
];

export function openDatabase(path = config.dbPath): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  if (current > MIGRATIONS.length) {
    throw new Error(
      `База на версии ${current}, а код знает только ${MIGRATIONS.length} миграций — откат не поддерживается`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
    log.info(`Миграция ${version + 1} применена`);
  }
}
