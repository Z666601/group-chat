-- 群聊系统数据库结构（SQLite）
-- 说明：本文件为幂等 DDL，可重复执行。迁移记录见 schema_migrations 表。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- ── 用户 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | banned
  kind          TEXT NOT NULL DEFAULT 'human',    -- human | agent
  created_at    TEXT NOT NULL
);

-- ── 智能体绑定（外部 agent 入群的身份与令牌）──────
CREATE TABLE IF NOT EXISTS agent_bindings (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  agent_key    TEXT NOT NULL,                 -- hermes | ekko | zcode | autoclaw | ...
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  UNIQUE (group_id, agent_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_bindings_group ON agent_bindings(group_id);

-- ── 会话（登录态）────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── 群组 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  avatar       TEXT NOT NULL DEFAULT '',
  owner_id     TEXT NOT NULL REFERENCES users(id),
  invite_code  TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active',    -- active | dissolved
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  dissolved_at TEXT
);

-- ── 群成员 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_members (
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',   -- owner | member
  joined_at     TEXT NOT NULL,
  removed_at    TEXT,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON group_members(user_id);

-- ── 消息 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,                  -- 群内单调递增序号，用于断线补齐
  sender_id     TEXT NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL DEFAULT 'text',      -- text | image | system
  body          TEXT NOT NULL DEFAULT '',
  attachment_id TEXT REFERENCES attachments(id),
  reply_to      TEXT REFERENCES messages(id),      -- 引用回复的目标消息
  client_msg_id TEXT,                              -- 客户端幂等键
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_group_seq ON messages(group_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedupe
  ON messages(group_id, sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_group_time ON messages(group_id, created_at);

-- ── 附件（图片）──────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  group_id    TEXT,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_uploader ON attachments(uploader_id);

-- ── 审计台账 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  type      TEXT NOT NULL,
  actor_id  TEXT,
  group_id  TEXT,
  target_id TEXT,
  detail    TEXT,
  ip        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_group ON audit_log(group_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(type, ts);
