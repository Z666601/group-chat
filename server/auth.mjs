// 鉴权：口令散列、会话令牌、权限判定
import crypto from 'node:crypto';
import { newId, nowIso } from './util.mjs';
import * as store from './db.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 天
export const COOKIE_NAME = 'gc_sid';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** 智能体令牌散列（只存散列，不存明文） */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function issueSession(userId, userAgent = '') {
  const token = newToken();
  store.sessions.create({
    token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    userAgent,
  });
  return token;
}

export function tokenFrom(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookies = parseCookieHeader(req.headers?.cookie);
  return cookies[COOKIE_NAME] || null;
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** 由令牌解析当前用户；返回 { user, token } 或 null */
export function resolveUser(token) {
  if (!token) return null;
  const s = store.sessions.get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    store.sessions.delete(token);
    return null;
  }
  const user = store.users.byId(s.user_id);
  if (!user || user.status !== 'active') return null;
  store.sessions.touch(token);
  return { user, token };
}

export function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar || '' };
}

export function cookieHeader(token, { clear = false } = {}) {
  if (clear) return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export const usernamePattern = /^[a-zA-Z0-9_]{3,24}$/;

export function validateCredentials({ username, password, displayName }) {
  const errors = [];
  if (!username || !usernamePattern.test(username)) {
    errors.push('用户名需为 3-24 位字母、数字或下划线');
  }
  if (!password || password.length < 8 || password.length > 128) {
    errors.push('密码长度需为 8-128 位');
  }
  if (displayName !== undefined) {
    if (!displayName || displayName.trim().length < 1 || displayName.trim().length > 32) {
      errors.push('昵称长度需为 1-32 位');
    }
  }
  return errors;
}

export { newId, nowIso };
