// 通用工具：ID、日志、指标、限流、HTTP 辅助
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ── HTTP 辅助 ────────────────────────────────────────
export function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function fail(res, status, code, message, extra = {}) {
  return json(res, status, { ok: false, error: { code, message, ...extra } });
}

export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

export function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// ── 日志（JSON Lines，落盘 + 控制台）─────────────────
export function createLogger({ dir, file = 'app.log', level } = {}) {
  const lvl = level || process.env.LOG_LEVEL || 'info';
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  let stream = null;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, file), { flags: 'a' });
  }
  const emit = (levelName, msg, meta) => {
    if (order[levelName] < order[lvl]) return;
    const rec = { ts: nowIso(), level: levelName, msg, ...(meta || {}) };
    const line = JSON.stringify(rec);
    if (stream) stream.write(line + '\n');
    if (levelName === 'error' || levelName === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    stream,
  };
}

// ── 指标 ─────────────────────────────────────────────
export function createMetrics() {
  const counters = new Map();
  const latencies = [];
  return {
    inc(name, n = 1) {
      counters.set(name, (counters.get(name) || 0) + n);
    },
    observe(name, ms) {
      latencies.push(ms);
      if (latencies.length > 5000) latencies.shift();
      counters.set(`${name}.count`, (counters.get(`${name}.count`) || 0) + 1);
      counters.set(`${name}.sum_ms`, +((counters.get(`${name}.sum_ms`) || 0) + ms).toFixed(3));
    },
    snapshot(extra = {}) {
      const sorted = [...latencies].sort((a, b) => a - b);
      const pct = (p) =>
        sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(2) : 0;
      return {
        counters: Object.fromEntries(counters),
        latencyMs: {
          count: sorted.length,
          p50: pct(50),
          p95: pct(95),
          p99: pct(99),
          max: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : 0,
        },
        ...extra,
      };
    },
  };
}

// ── 限流（令牌桶）────────────────────────────────────
export function createRateLimiter({ capacity = 10, refillPerSec = 1 } = {}) {
  const buckets = new Map();
  return {
    check(key, cost = 1) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, ts: now };
        buckets.set(key, b);
      }
      const elapsed = (now - b.ts) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
      b.ts = now;
      if (b.tokens < cost) {
        return { ok: false, retryAfterMs: Math.ceil(((cost - b.tokens) / refillPerSec) * 1000) };
      }
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens) };
    },
    reset(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
  };
}
