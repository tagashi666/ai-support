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
