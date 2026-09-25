// 容量与性能基线压测
// 用法：node --no-warnings tests/loadtest.mjs
// 可调：LOAD_USERS(默认500) LOAD_SENDERS(默认20) LOAD_MESSAGES(默认200) PORT(默认8801)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8801);
const BASE = `http://127.0.0.1:${PORT}`;
const USERS = Number(process.env.LOAD_USERS || 500);
const SENDERS = Number(process.env.LOAD_SENDERS || 20);
const MESSAGES = Number(process.env.LOAD_MESSAGES || 200);
const DATA_DIR = path.join(ROOT, 'data', 'load');
const ADMIN_TOKEN = 'load-admin-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  return false;
}

/** 直连数据库播种测试数据（压测专用快路径，避免 500 次 scrypt 开销） */
async function seed() {
  const store = await import('../server/db.mjs');
  store.initDb({ file: path.join(DATA_DIR, 'chat.db'), schemaFile: path.join(ROOT, 'db', 'schema.sql') });
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const tokens = [];

  const db = store.getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    // 群主
    const ownerId = 'usr_load_owner';
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, avatar, status, created_at)
       VALUES (?, ?, ?, 'x', '', 'active', ?)`,
    ).run(ownerId, 'load_owner', '压测群主', now);
    const groupId = 'grp_load_001';
    db.prepare(
      `INSERT INTO groups (id, name, avatar, owner_id, invite_code, status, created_at, updated_at)
       VALUES (?, '压测群', '', ?, 'load-invite-code', 'active', ?, ?)`,
    ).run(groupId, ownerId, now, now);
    db.prepare(
      `INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_seq)
       VALUES (?, ?, 'owner', ?, 0)`,
    ).run(groupId, ownerId, now);

    const insUser = db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, avatar, status, created_at)
       VALUES (?, ?, ?, 'x', '', 'active', ?)`,
    );
    const insMember = db.prepare(
      `INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_seq)
       VALUES (?, ?, 'member', ?, 0)`,
    );
    const insSession = db.prepare(
      `INSERT INTO sessions (token, user_id, created_at, last_seen_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, 'loadtest')`,
    );

    const ownerToken = 'load-token-0';
    insSession.run(ownerToken, ownerId, now, now, expires);
    tokens.push({ token: ownerToken, userId: ownerId });

    for (let i = 1; i < USERS; i++) {
      const uid = `usr_load_${i}`;
      insUser.run(uid, `load_${i}`, `压测用户${i}`, now);
      insMember.run(groupId, uid, now);
      const tk = `load-token-${i}`;
      insSession.run(tk, uid, now, now, expires);
      tokens.push({ token: tk, userId: uid });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { groupId: 'grp_load_001', tokens };
}

function connectWs(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const client = { ws, ready: false, subscribed: false, received: 0 };
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      client.received++;
      if (m.type === 'ready') client.ready = true;
      if (m.type === 'subscribed') client.subscribed = true;
      if (client.onMessage) client.onMessage(m);
    });
    ws.addEventListener('open', () => resolve(client));
    ws.addEventListener('error', () => resolve(client));
    setTimeout(() => resolve(client), 8000);
  });
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n启动被测服务（PORT=${PORT}）...`);
const server = spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, ADMIN_TOKEN, LOG_LEVEL: 'silent' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => {
  const s = String(d);
  if (!s.includes('ExperimentalWarning')) process.stderr.write('[server] ' + s);
});
const shutdown = () => {
  try {
    server.kill('SIGTERM');
  } catch {
    /* ignore */
  }
};
process.on('exit', shutdown);

const report = { startedAt: new Date().toISOString(), config: { users: USERS, senders: SENDERS, messages: MESSAGES } };

try {
  if (!(await waitHealthy())) throw new Error('服务未就绪');

  console.log(`播种 ${USERS} 个用户 + 1 个群 ...`);
  const seedT0 = Date.now();
  const { groupId, tokens } = await seed();
  report.seedMs = Date.now() - seedT0;

  console.log(`建立 ${USERS} 条 WebSocket 连接 ...`);
  const tConn = Date.now();
  const clients = [];
  const BATCH = 50;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    clients.push(...(await Promise.all(batch.map((t) => connectWs(t.token)))));
  }
  report.connectMs = Date.now() - tConn;
  const connected = clients.filter((c) => c.ready).length;
  report.connected = connected;
  console.log(`已连接 ${connected} / ${USERS}，用时 ${report.connectMs}ms`);

  // 全部订阅
  for (const c of clients) if (c.ready) c.ws.send(JSON.stringify({ type: 'subscribe', groupId, sinceSeq: 0 }));
  let subT0 = Date.now();
  while (clients.filter((c) => c.subscribed).length < connected && Date.now() - subT0 < 15000) await sleep(100);
  const subscribed = clients.filter((c) => c.subscribed).length;
  report.subscribed = subscribed;
  console.log(`已订阅 ${subscribed} / ${connected}`);

  // 延迟采样（每个连接只采样前若干条，避免体量过大）
  const sendTimes = new Map();
  const latencies = [];
  let deliveries = 0;
  for (const c of clients) {
    if (!c.subscribed) continue;
    c.onMessage = (m) => {
      if (m.type !== 'message') return;
      deliveries++;
      const t0 = sendTimes.get(m.message.seq);
      if (t0 && latencies.length < 40000) latencies.push(Date.now() - t0);
    };
  }

  console.log(`开始压测：${SENDERS} 个发送者 × ${MESSAGES / SENDERS} 条消息 ...`);
  const senders = clients.slice(0, SENDERS).filter((c) => c.subscribed);
  const perSender = Math.max(1, Math.floor(MESSAGES / Math.max(1, senders.length)));

  // 先挂 ACK 收集器，再发送（否则会漏记发送时刻）
  let sentOk = 0;
  const pendingAcks = new Set();
  for (const c of senders) {
    const prev = c.onMessage;
    c.onMessage = (m) => {
      if (m.type === 'ack' && pendingAcks.has(m.clientMsgId)) {
        sendTimes.set(m.seq, Date.now());
        sentOk++;
        pendingAcks.delete(m.clientMsgId);
      }
      if (prev) prev(m);
    };
  }

  const wallT0 = Date.now();
  await Promise.all(
    senders.map(async (c, idx) => {
      for (let k = 0; k < perSender; k++) {
        const clientMsgId = `load-${idx}-${k}-${Date.now()}`;
        pendingAcks.add(clientMsgId);
        c.ws.send(
          JSON.stringify({ type: 'send', groupId, clientMsgId, text: `压测消息 ${idx}-${k} ` + 'x'.repeat(60) }),
        );
        await sleep(35); // 轻度节拍，避开令牌桶突发上限
      }
    }),
  );
  await sleep(200);
  const wantAcks = senders.length * perSender;
  const ackT0 = Date.now();
  while (sentOk < wantAcks && Date.now() - ackT0 < 10000) await sleep(50);
  // 等待扇出完成
  const expect = sentOk * subscribed;
  const fanT0 = Date.now();
  while (deliveries < expect && Date.now() - fanT0 < 30000) await sleep(100);
  report.sendWallMs = Date.now() - wallT0;

  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0);
  report.sent = sentOk;
  report.deliveries = deliveries;
  report.expectedDeliveries = expect;
  report.missingDeliveries = Math.max(0, expect - deliveries);
  report.deliveryErrorRate = expect ? +(((expect - deliveries) / expect) * 100).toFixed(4) : 0;
  report.latencyMs = {
    samples: latencies.length,
    p50: pct(50),
    p90: pct(90),
    p95: pct(95),
    p99: pct(99),
    max: latencies.length ? latencies[latencies.length - 1] : 0,
  };
  const mem = process.memoryUsage();
  report.clientMemoryMB = +(mem.rss / 1024 / 1024).toFixed(1);

  let metrics = { data: {} };
  try {
    const metricsRes = await fetch(`${BASE}/api/admin/metrics`, { headers: { 'x-admin-token': ADMIN_TOKEN } });
    metrics = { status: metricsRes.status, data: await metricsRes.json() };
  } catch (e) {
    metrics = { error: String(e?.message || e) };
  }
  report.serverMetricsStatus = metrics.status || metrics.error;
  report.serverMetrics = metrics.data?.metrics;

  console.log('\n════════ 压测结果 ════════');
  console.log(`在线连接      : ${connected} / ${USERS}`);
  console.log(`订阅成功      : ${subscribed}`);
  console.log(`发送消息      : ${sentOk}`);
  console.log(`投递次数      : ${deliveries} / 期望 ${expect}（缺失 ${report.missingDeliveries}，错误率 ${report.deliveryErrorRate}%）`);
  console.log(`总耗时        : ${report.sendWallMs}ms（含等待扇出）`);
  console.log(`投递延迟(ms)  : p50=${report.latencyMs.p50} p90=${report.latencyMs.p90} p95=${report.latencyMs.p95} p99=${report.latencyMs.p99} max=${report.latencyMs.max}（样本 ${report.latencyMs.samples}）`);
  console.log(`服务端指标    : ${JSON.stringify(report.serverMetrics?.counters || {})}`);
  console.log(`服务端延迟    : ${JSON.stringify(report.serverMetrics?.latencyMs || {})}`);

  for (const c of clients) {
    try {
      c.ws.close();
    } catch {
      /* ignore */
    }
  }
} catch (err) {
  console.error('[FATAL] ' + (err?.stack || err));
  report.fatal = String(err?.message || err);
} finally {
  shutdown();
  await sleep(300);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'loadtest-report.json'), JSON.stringify(report, null, 2));
console.log(`报告已写入: ${path.join(DATA_DIR, 'loadtest-report.json')}`);
