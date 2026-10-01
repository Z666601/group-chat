// 服务入口：HTTP + 静态资源 + WebSocket 实时通道
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, createMetrics, clientIp, json } from './util.mjs';
import * as store from './db.mjs';
import * as auth from './auth.mjs';
import { attachWebSocketServer } from './ws.mjs';
import { createHub, DEFAULT_LIMITS } from './hub.mjs';
import { createRouter } from './http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERSION = '1.0.0';

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// 模型下拉的兜底选项（当本机模型目录读不到时仍可选）
const MODEL_FALLBACK = [
  'zai_glm-5.3-flash',
  'glm-5.3',
  'GLM-5.3-flash',
  'glm-5.2',
  'gpt-5.5',
  'gpt-5.4',
  'claude-sonnet-4.6',
  'claude-opus-4.6',
  'gemini-3.1-pro',
  'deepseek-v4-pro',
  'kimi-k2.6',
  'qwen3.8-max',
];

const config = {
  version: VERSION,
  modelOptions: MODEL_FALLBACK,
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 8787),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),
  webDir: path.join(ROOT, 'web'),
  // 本机免密进入：只在服务绑定回环地址时默认开启，可用 LOCAL_AUTOLOGIN=0 关掉。
  // 判定本机用的是 socket 的真实远端地址，不看 X-Forwarded-For（那个头可以被伪造）。
  localAutologin: process.env.LOCAL_AUTOLOGIN
    ? process.env.LOCAL_AUTOLOGIN !== '0'
    : /^(127\.|\[::1\]|::1|localhost$)/.test(process.env.HOST || '127.0.0.1'),
  localAutologinUser: process.env.LOCAL_AUTOLOGIN_USER || 'app_owner',
  schemaFile: path.join(ROOT, 'db', 'schema.sql'),
  maxGroupMembers: intEnv('MAX_GROUP_MEMBERS', 200),
  limits: {
    ...DEFAULT_LIMITS,
    maxTextLength: intEnv('MAX_TEXT_LENGTH', DEFAULT_LIMITS.maxTextLength),
    maxImageBytes: intEnv('MAX_IMAGE_MB', 5) * 1024 * 1024,
  },
};

config.dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(config.dataDir, 'chat.db');
const logDir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(config.dataDir, 'logs');

const log = createLogger({ dir: logDir, file: 'app.log', level: process.env.LOG_LEVEL || 'info' });
const metrics = createMetrics();

store.initDb({ file: config.dbFile, schemaFile: config.schemaFile });
log.info('db.ready', { file: config.dbFile, counts: store.tableCounts() });

// 管理令牌：优先 ADMIN_TOKEN 环境变量；否则从 ADMIN_TOKEN_FILE 指向的文件读取（推荐，避免密钥出现在命令行/进程列表里）
let adminToken = process.env.ADMIN_TOKEN || '';
if (!adminToken && process.env.ADMIN_TOKEN_FILE) {
  const f = path.resolve(process.env.ADMIN_TOKEN_FILE);
  if (fs.existsSync(f)) adminToken = fs.readFileSync(f, 'utf8').trim();
}
config.adminTokenFile = process.env.ADMIN_TOKEN_FILE ? path.resolve(process.env.ADMIN_TOKEN_FILE) : null;

const hub = createHub({ log, metrics, limits: config.limits });
const router = createRouter({
  log,
  metrics,
  hub,
  config,
  adminToken,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/join') rel = '/index.html';
  const target = path.normalize(path.join(config.webDir, rel));
  if (!target.startsWith(config.webDir)) {
    return json(res, 403, { ok: false, error: { code: 'forbidden', message: '路径非法' } });
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return json(res, 404, { ok: false, error: { code: 'not_found', message: '资源不存在' } });
  }
  const ext = path.extname(target).toLowerCase();
  const data = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': data.length,
    // HTML/JS/CSS 完全不缓存：避免升级后浏览器拿到旧脚本（图片等静态资源可缓存）
    'cache-control': ['.html', '.js', '.css'].includes(ext) ? 'no-store' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
  return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    const handled = await router.dispatch(req, res);
    if (handled === false) serveStatic(req, res, new URL(req.url, `http://${req.headers.host || 'localhost'}`));
  } catch (err) {
    log.error('http.unhandled', { err: String(err?.stack || err), path: req.url });
    metrics.inc('http.error');
    if (!res.headersSent) {
      json(res, 500, { ok: false, error: { code: 'internal_error', message: '服务器内部错误' } });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
});

// ── WebSocket 挂载 ───────────────────────────────────
attachWebSocketServer(server, {
  onConnection: (conn, req) => {
    conn.subs = new Set();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    conn.meta = { ip: clientIp(req), ua: String(req.headers['user-agent'] || '') };

    // 智能体连接：?agentToken=xxx → 以绑定的 Agent 身份接入
    const agentToken = url.searchParams.get('agentToken');
    if (agentToken) {
      const binding = store.agents.byTokenHash(auth.hashToken(agentToken));
      if (binding && binding.group_status === 'active') {
        conn.user = {
          id: binding.user_id,
          username: binding.username,
          displayName: binding.display_name,
          avatar: binding.avatar || '',
          kind: 'agent',
        };
        conn.agentKey = binding.agent_key;
        conn.homeGroupId = binding.group_id;
        conn.subs = new Set();
        hub.trackUser(conn.user.id);
        metrics.inc('ws.open_agent');
        conn.sendJSON({
          type: 'ready',
          user: { ...conn.user },
          agentKey: binding.agent_key,
          groupId: binding.group_id,
          limits: config.limits,
          serverTime: new Date().toISOString(),
        });
        conn.on('message', (raw, isBinary) => hub.handle(conn, raw, isBinary));
        conn.on('close', () => {
          hub.untrackUser(conn.user.id);
          hub.onClose(conn);
        });
        conn.on('wserror', (err) => log.warn('ws.error', { err: String(err?.message || err) }));
        return;
      }
      metrics.inc('ws.open_agent_rejected');
      conn.sendJSON({ type: 'ready', user: null, error: 'invalid_agent_token' });
      conn.on('close', () => hub.onClose(conn));
      return;
    }

    let token = url.searchParams.get('token');
    if (!token) {
      const cookie = String(req.headers.cookie || '');
      const m = cookie.match(new RegExp(`${auth.COOKIE_NAME}=([^;]+)`));
      if (m) token = decodeURIComponent(m[1]);
    }
    const resolved = auth.resolveUser(token);
    if (resolved) {
      conn.user = resolved.user;
      conn.token = resolved.token;
      hub.trackUser(conn.user.id);
      metrics.inc('ws.open');
      conn.sendJSON({
        type: 'ready',
        user: auth.publicUser(conn.user),
        limits: config.limits,
        serverTime: new Date().toISOString(),
      });
    } else {
      metrics.inc('ws.open_anonymous');
      conn.sendJSON({ type: 'ready', user: null, error: 'unauthenticated' });
    }

    conn.on('message', (raw, isBinary) => hub.handle(conn, raw, isBinary));
    conn.on('close', () => {
      if (conn.user) hub.untrackUser(conn.user.id);
      hub.onClose(conn);
    });
    conn.on('wserror', (err) => log.warn('ws.error', { err: String(err?.message || err) }));
  },
});

// ── 维护任务 ─────────────────────────────────────────
const maintenance = setInterval(() => {
  const removed = store.sessions.deleteExpired();
  if (removed) metrics.inc('session.expired', removed);
  log.info('maintenance.tick', { counts: store.tableCounts() });
}, 15 * 60 * 1000);
maintenance.unref?.();

server.listen(config.port, config.host, () => {
  log.info('server.listening', {
    url: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    adminApi: adminToken ? 'enabled' : 'disabled(no admin token)',
  });
  console.log(`\n  群聊服务已启动  →  http://${config.host}:${config.port}\n`);
});

function shutdown(signal) {
  log.info('server.shutdown', { signal });
  clearInterval(maintenance);
  server.close(() => {
    store.closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { config, log, metrics, hub, server };
