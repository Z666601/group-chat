// 数据访问层：SQLite（node:sqlite）+ 领域查询
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, newId } from './util.mjs';

let db = null;

export function initDb({ file, schemaFile }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  const schema = fs.readFileSync(schemaFile, 'utf8');
  db.exec(schema);
  // 轻量迁移：老库补 users.kind 列（SQLite 不支持 IF NOT EXISTS 加列）
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('kind')) {
    db.exec("ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'");
  }
  const acols = db.prepare('PRAGMA table_info(agent_bindings)').all().map((c) => c.name);
  if (!acols.includes('model')) {
    db.exec("ALTER TABLE agent_bindings ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  if (!acols.includes('supports_model')) {
    db.exec('ALTER TABLE agent_bindings ADD COLUMN supports_model INTEGER NOT NULL DEFAULT 1');
  }
  const mcols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!mcols.includes('reply_to')) {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT REFERENCES messages(id)');
  }
  const row = get('SELECT MAX(version) AS v FROM schema_migrations');
  if (!row || row.v === null || row.v === undefined) {
    run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
      1,
      '001_init',
      nowIso(),
    ]);
  }
  return db;
}

export function getDb() {
  if (!db) throw new Error('db not initialised');
  return db;
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}
export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}
export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function tx(fn) {
  getDb().exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    getDb().exec('COMMIT');
    return out;
  } catch (err) {
    try {
      getDb().exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ── 用户 ─────────────────────────────────────────────
export const users = {
  create({ username, displayName, passwordHash, avatar = '', kind = 'human' }) {
    const id = newId('usr');
    run(
      `INSERT INTO users (id, username, display_name, password_hash, avatar, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, username, displayName, passwordHash, avatar, kind, nowIso()],
    );
    return this.byId(id);
  },
  byUsernameOnly(username) {
    return get('SELECT * FROM users WHERE username = ?', [username]);
  },
  byId(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },
  byUsername(username) {
    return get('SELECT * FROM users WHERE username = ?', [username]);
  },
  setStatus(id, status) {
    run('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  },
  publicView(u) {
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      avatar: u.avatar || '',
      kind: u.kind || 'human',
    };
  },
};

// ── 智能体绑定 ──────────────────────────────────
export const agents = {
  upsert({ groupId, agentKey, userId, tokenHash, supportsModel = true }) {
    const sm = supportsModel ? 1 : 0;
    const existing = this.get(groupId, agentKey);
    if (existing) {
      run(
        'UPDATE agent_bindings SET token_hash = ?, status = ?, user_id = ?, supports_model = ? WHERE id = ?',
        [tokenHash, 'active', userId, sm, existing.id],
      );
      return this.get(groupId, agentKey);
    }
    const id = newId('agt');
    run(
      `INSERT INTO agent_bindings (id, group_id, agent_key, user_id, token_hash, status, supports_model, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, groupId, agentKey, userId, tokenHash, sm, nowIso()],
    );
    return this.get(groupId, agentKey);
  },
  /** groupId -> { agentKey: supportsModel } */
  capsByGroup(groupId) {
    const out = {};
    for (const b of this.list(groupId)) out[b.agent_key] = Number(b.supports_model) !== 0;
    return out;
  },
  get(groupId, agentKey) {
    return get('SELECT * FROM agent_bindings WHERE group_id = ? AND agent_key = ?', [groupId, agentKey]);
  },
  byTokenHash(hash) {
    return get(
      `SELECT b.*, u.display_name, u.avatar, u.username, u.kind, g.status AS group_status
         FROM agent_bindings b
         JOIN users u ON u.id = b.user_id
         JOIN groups g ON g.id = b.group_id
        WHERE b.token_hash = ? AND b.status = 'active'`,
      [hash],
    );
  },
  list(groupId) {
    return all(
      `SELECT b.*, u.display_name, u.avatar FROM agent_bindings b
         JOIN users u ON u.id = b.user_id WHERE b.group_id = ?`,
      [groupId],
    );
  },
  /** 按群 + agentKey 查询绑定（用于读取/设置所选模型） */
  byKey(groupId, agentKey) {
    return get('SELECT * FROM agent_bindings WHERE group_id = ? AND agent_key = ?', [groupId, agentKey]);
  },
  setModel(groupId, agentKey, model) {
    run('UPDATE agent_bindings SET model = ? WHERE group_id = ? AND agent_key = ?', [
      String(model || ''),
      groupId,
      agentKey,
    ]);
    return this.byKey(groupId, agentKey);
  },
  /** groupId -> { agentKey: model } */
  modelsByGroup(groupId) {
    const out = {};
    for (const b of this.list(groupId)) out[b.agent_key] = b.model || '';
    return out;
  },
};

// ── 会话 ─────────────────────────────────────────────
export const sessions = {
  create({ token, userId, expiresAt, userAgent = '' }) {
    const t = nowIso();
    run(
      `INSERT INTO sessions (token, user_id, created_at, last_seen_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [token, userId, t, t, expiresAt, userAgent],
    );
  },
  get(token) {
    return get('SELECT * FROM sessions WHERE token = ?', [token]);
  },
  touch(token) {
    run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', [nowIso(), token]);
  },
  delete(token) {
    run('DELETE FROM sessions WHERE token = ?', [token]);
  },
  deleteExpired() {
    const r = run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
    return Number(r.changes || 0);
  },
  countActive() {
    return get('SELECT COUNT(*) AS c FROM sessions WHERE expires_at >= ?', [nowIso()])?.c ?? 0;
  },
};

// ── 群组 ─────────────────────────────────────────────
export const groups = {
  create({ name, avatar = '', ownerId }) {
    const id = newId('grp');
    const t = nowIso();
    const inviteCode = newId('inv').slice(4);
    tx(() => {
      run(
        `INSERT INTO groups (id, name, avatar, owner_id, invite_code, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, name, avatar, ownerId, inviteCode, t, t],
      );
      run(
        `INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_seq)
         VALUES (?, ?, 'owner', ?, 0)`,
        [id, ownerId, t],
      );
    });
    return this.byId(id);
  },
  byId(id) {
    return get('SELECT * FROM groups WHERE id = ?', [id]);
  },
  byInvite(code) {
    return get('SELECT * FROM groups WHERE invite_code = ?', [code]);
  },
  update(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return this.byId(id);
    const setSql = keys.map((k) => `${k} = ?`).join(', ');
    run(`UPDATE groups SET ${setSql}, updated_at = ? WHERE id = ?`, [
      ...keys.map((k) => fields[k]),
      nowIso(),
      id,
    ]);
    return this.byId(id);
  },
  dissolve(id) {
    const t = nowIso();
    run(`UPDATE groups SET status = 'dissolved', dissolved_at = ?, updated_at = ? WHERE id = ?`, [
      t,
      t,
      id,
    ]);
  },
  listForUser(userId) {
    return all(
      `SELECT g.*, m.role, m.last_read_seq,
              (SELECT MAX(seq) FROM messages WHERE group_id = g.id AND deleted_at IS NULL) AS latest_seq,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.removed_at IS NULL) AS member_count
         FROM groups g
         JOIN group_members m ON m.group_id = g.id AND m.user_id = ? AND m.removed_at IS NULL
        WHERE g.status = 'active'
        ORDER BY g.updated_at DESC`,
      [userId],
    );
  },
};

// ── 群成员 ───────────────────────────────────────────
export const members = {
  /** 只查绑定里的模型设置（不依赖 agentKey 是否存在） */
  modelOf(groupId, agentKey) {
    const b = get('SELECT model FROM agent_bindings WHERE group_id = ? AND agent_key = ?', [groupId, agentKey]);
    return b?.model || '';
  },
  add(groupId, userId, role = 'member') {
    const existing = this.get(groupId, userId);
    if (existing) {
      if (existing.removed_at) {
        run(
          `UPDATE group_members SET removed_at = NULL, joined_at = ?, role = ?
            WHERE group_id = ? AND user_id = ?`,
          [nowIso(), role, groupId, userId],
        );
      }
      return this.get(groupId, userId);
    }
    run(
      `INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_seq)
       VALUES (?, ?, ?, ?, 0)`,
      [groupId, userId, role, nowIso()],
    );
    return this.get(groupId, userId);
  },
  get(groupId, userId) {
    return get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  },
  isActive(groupId, userId) {
    const m = get(
      `SELECT 1 AS ok FROM group_members
        WHERE group_id = ? AND user_id = ? AND removed_at IS NULL`,
      [groupId, userId],
    );
    return !!m;
  },
  remove(groupId, userId) {
    run(`UPDATE group_members SET removed_at = ? WHERE group_id = ? AND user_id = ?`, [
      nowIso(),
      groupId,
      userId,
    ]);
  },
  list(groupId) {
    return all(
      `SELECT m.user_id, m.role, m.joined_at, m.last_read_seq,
              u.username, u.display_name, u.avatar, u.kind
         FROM group_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ? AND m.removed_at IS NULL
        ORDER BY CASE u.kind WHEN 'agent' THEN 1 ELSE 0 END ASC,
                 CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at ASC`,
      [groupId],
    );
  },
  activeIds(groupId) {
    return all(
      `SELECT user_id FROM group_members WHERE group_id = ? AND removed_at IS NULL`,
      [groupId],
    ).map((r) => r.user_id);
  },
  setLastRead(groupId, userId, seq) {
    run(
      `UPDATE group_members SET last_read_seq = MAX(last_read_seq, ?)
        WHERE group_id = ? AND user_id = ?`,
      [seq, groupId, userId],
    );
  },
};

// ── 消息 ─────────────────────────────────────────────
export const messages = {
  nextSeq(groupId) {
    const r = get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE group_id = ?', [groupId]);
    return Number(r.m) + 1;
  },
  insert({ groupId, senderId, type = 'text', body = '', attachmentId = null, clientMsgId = null, replyTo = null, seq }) {
    const id = newId('msg');
    const t = nowIso();
    run(
      `INSERT INTO messages (id, group_id, seq, sender_id, type, body, attachment_id, reply_to, client_msg_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, groupId, seq, senderId, type, body, attachmentId, replyTo, clientMsgId, t],
    );
    return this.byId(id);
  },
  byId(id) {
    return get(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar AS sender_avatar, u.kind AS sender_kind
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?`,
      [id],
    );
  },
  findByClientId(groupId, senderId, clientMsgId) {
    return get(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar AS sender_avatar, u.kind AS sender_kind
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.group_id = ? AND m.sender_id = ? AND m.client_msg_id = ?`,
      [groupId, senderId, clientMsgId],
    );
  },
  page(groupId, { beforeSeq = null, limit = 30 } = {}) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 30));
    const rows = beforeSeq
      ? all(
          `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
                  u.avatar AS sender_avatar, u.kind AS sender_kind
             FROM messages m JOIN users u ON u.id = m.sender_id
            WHERE m.group_id = ? AND m.deleted_at IS NULL AND m.seq < ?
            ORDER BY m.seq DESC LIMIT ?`,
          [groupId, Number(beforeSeq), lim],
        )
      : all(
          `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
                  u.avatar AS sender_avatar, u.kind AS sender_kind
             FROM messages m JOIN users u ON u.id = m.sender_id
            WHERE m.group_id = ? AND m.deleted_at IS NULL
            ORDER BY m.seq DESC LIMIT ?`,
          [groupId, lim],
        );
    return rows.reverse();
  },
  // 定位模式：取某条消息附近的窗口（搜索结果跳转用）
  pageAround(groupId, seq, limit = 30) {
    const lim = Math.max(5, Math.min(100, Number(limit) || 30));
    const half = Math.floor(lim / 2);
    const s = Number(seq) || 0;
    return all(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar AS sender_avatar, u.kind AS sender_kind
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.group_id = ? AND m.deleted_at IS NULL AND m.seq >= ? AND m.seq <= ?
        ORDER BY m.seq ASC LIMIT ?`,
      [groupId, Math.max(1, s - half), s + half, lim],
    );
  },
  since(groupId, sinceSeq, limit = 500) {
    return all(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username,
              u.avatar AS sender_avatar, u.kind AS sender_kind
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.group_id = ? AND m.deleted_at IS NULL AND m.seq > ?
        ORDER BY m.seq ASC LIMIT ?`,
      [groupId, Number(sinceSeq) || 0, limit],
    );
  },
  latestSeq(groupId) {
    const r = get(
      'SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE group_id = ? AND deleted_at IS NULL',
      [groupId],
    );
    return Number(r.m);
  },
  countInGroup(groupId) {
    return (
      get('SELECT COUNT(*) AS c FROM messages WHERE group_id = ? AND deleted_at IS NULL', [groupId])
        ?.c ?? 0
    );
  },
  countAll() {
    return get('SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NULL')?.c ?? 0;
  },
  search({ groupId = null, from = null, to = null, q = null, limit = 100 } = {}) {
    const where = ['m.deleted_at IS NULL'];
    const params = [];
    if (groupId) {
      where.push('m.group_id = ?');
      params.push(groupId);
    }
    if (from) {
      where.push('m.created_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('m.created_at <= ?');
      params.push(to);
    }
    if (q) {
      const kw = String(q).slice(0, 100);
      where.push(`m.type = 'text' AND m.body LIKE ? ESCAPE '\\'`);
      params.push('%' + kw.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%');
    }
    params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
    return all(
      `SELECT m.id, m.group_id, m.seq, m.sender_id, m.type, m.body, m.created_at,
              u.username AS sender_username, u.display_name AS sender_name,
              u.avatar AS sender_avatar, u.kind AS sender_kind
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC LIMIT ?`,
      params,
    );
  },
};

// ── 附件 ─────────────────────────────────────────────
export const attachments = {
  create({ id, groupId = null, uploaderId, filename, mime, size, filePath }) {
    run(
      `INSERT INTO attachments (id, group_id, uploader_id, filename, mime, size, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, groupId, uploaderId, filename, mime, size, filePath, nowIso()],
    );
    return this.byId(id);
  },
  byId(id) {
    return get('SELECT * FROM attachments WHERE id = ?', [id]);
  },
};

// ── 审计台账 ─────────────────────────────────────────
export const audit = {
  log({ type, actorId = null, groupId = null, targetId = null, detail = null, ip = null }) {
    run(
      `INSERT INTO audit_log (ts, type, actor_id, group_id, target_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nowIso(), type, actorId, groupId, targetId, detail ? JSON.stringify(detail) : null, ip],
    );
  },
  search({ groupId = null, actorId = null, type = null, from = null, to = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (groupId) {
      where.push('group_id = ?');
      params.push(groupId);
    }
    if (actorId) {
      where.push('actor_id = ?');
      params.push(actorId);
    }
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    if (from) {
      where.push('ts >= ?');
      params.push(from);
    }
    if (to) {
      where.push('ts <= ?');
      params.push(to);
    }
    params.push(Math.max(1, Math.min(5000, Number(limit) || 100)));
    const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT ?`;
    return all(sql, params).map((r) => ({
      ...r,
      detail: r.detail ? safeParse(r.detail) : null,
    }));
  },
  countByType() {
    return all('SELECT type, COUNT(*) AS c FROM audit_log GROUP BY type ORDER BY c DESC');
  },
  countAll() {
    return get('SELECT COUNT(*) AS c FROM audit_log')?.c ?? 0;
  },
};

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function tableCounts() {
  const t = (name) => get(`SELECT COUNT(*) AS c FROM ${name}`)?.c ?? 0;
  return {
    users: t('users'),
    sessions: t('sessions'),
    groups: t('groups'),
    group_members: t('group_members'),
    messages: t('messages'),
    attachments: t('attachments'),
    audit_log: t('audit_log'),
    agent_bindings: t('agent_bindings'),
  };
}

export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}
