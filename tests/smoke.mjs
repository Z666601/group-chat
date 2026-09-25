// 端到端自检：注册/登录 → 建群 → 邀请加入 → 实时收发 → 断线补齐 → 越权 → 限流 → 审计 → 解散
// 用法：node --no-warnings tests/smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'smoke-admin-token';
const DATA_DIR = path.join(ROOT, 'data', 'smoke');

const results = [];
let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}

async function api(p, { method = 'GET', body, token, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (raw !== undefined) opts.body = raw;
  const url = BASE + (p.startsWith('/api') || p === '/healthz' ? p : '/api' + p);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, headers: res.headers };
}

function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const buffer = [];
    ws.addEventListener('message', (ev) => {
      try {
        buffer.push(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('open', () => {
      resolve({
        ws,
        send: (obj) => ws.send(JSON.stringify(obj)),
        buffer,
        // 轮询缓冲取第一条匹配消息（取走后从缓冲移除），超时抛错
        next: async (timeoutMs = 3000, filter = null) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const idx = filter ? buffer.findIndex(filter) : buffer.length ? 0 : -1;
            if (idx >= 0) return buffer.splice(idx, 1)[0];
            if (Date.now() > deadline) throw new Error('ws timeout waiting for message');
            await new Promise((r) => setTimeout(r, 15));
          }
        },
        close: () => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}

async function waitHealthy(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await api('/healthz');
      if (r.status === 200) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ── 启动被测服务 ─────────────────────────────────────
fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n启动被测服务（PORT=${PORT}, DATA_DIR=${DATA_DIR}）...`);
const server = spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR,
    ADMIN_TOKEN,
    LOG_LEVEL: 'silent',
  },
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

const summary = { startedAt: new Date().toISOString(), latency: {}, counts: {}, samples: {} };

try {
  if (!(await waitHealthy())) throw new Error('服务未在 15s 内就绪');

  console.log('\n── 1. 基础与健康检查 ─────────────────────────');
  const health = await api('/healthz');
  check('健康检查返回 200 且表可用', health.status === 200 && health.data.db, JSON.stringify(health.data.db));
  summary.counts.initialTables = health.data.db;

  console.log('\n── 2. 注册与登录 ─────────────────────────────');
  const regA = await api('/auth/register', { method: 'POST', body: { username: 'alice', password: 'password123', displayName: '爱丽丝' } });
  check('注册用户 A 成功', regA.status === 201 && regA.data.token, `status=${regA.status}`);
  const tokenA = regA.data.token;
  const userA = regA.data.user;

  const regB = await api('/auth/register', { method: 'POST', body: { username: 'bob', password: 'password123', displayName: '鲍勃' } });
  check('注册用户 B 成功', regB.status === 201 && regB.data.token);
  const tokenB = regB.data.token;
  const userB = regB.data.user;

  const regC = await api('/auth/register', { method: 'POST', body: { username: 'carol', password: 'password123', displayName: '卡罗尔' } });
  check('注册用户 C 成功', regC.status === 201 && regC.data.token);
  const tokenC = regC.data.token;
  const userC = regC.data.user;

  const dup = await api('/auth/register', { method: 'POST', body: { username: 'alice', password: 'password123' } });
  check('重复用户名被拒绝（409）', dup.status === 409, `status=${dup.status}`);

  const badLogin = await api('/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } });
  check('错误密码被拒绝（401）', badLogin.status === 401, `status=${badLogin.status}`);

  const loginA = await api('/auth/login', { method: 'POST', body: { username: 'alice', password: 'password123' } });
  check('用户 A 可二次登录（新会话）', loginA.status === 200 && loginA.data.token !== tokenA);

  const noAuth = await api('/groups');
  check('未登录访问 /groups 被拒绝（401）', noAuth.status === 401, `status=${noAuth.status}`);

  console.log('\n── 3. 建群与成员管理 ─────────────────────────');
  const created = await api('/groups', { method: 'POST', token: tokenA, body: { name: '产品讨论组' } });
  check('创建群聊成功且创建者为群主', created.status === 201 && created.data.group.role === 'owner');
  const groupId = created.data.group.id;

  const invite = await api(`/groups/${groupId}/invite`, { method: 'POST', token: tokenA });
  check('获取邀请码成功', invite.status === 200 && invite.data.inviteCode, `code=${invite.data.inviteCode}`);
  const inviteCode = invite.data.inviteCode;

  const joined = await api('/groups/join', { method: 'POST', token: tokenB, body: { inviteCode } });
  check('用户 B 凭邀请码入群', joined.status === 200 && joined.data.group.id === groupId);

  const detail = await api(`/groups/${groupId}`, { token: tokenA });
  check('群详情返回 2 名成员', detail.status === 200 && detail.data.members.length === 2, `members=${detail.data.members.length}`);

  const wrongCode = await api('/groups/join', { method: 'POST', token: tokenC, body: { inviteCode: 'not-a-real-code' } });
  check('无效邀请码被拒绝（404）', wrongCode.status === 404, `status=${wrongCode.status}`);

  console.log('\n── 4. 越权边界（服务端拒绝 + 审计）──────────');
  const cRead = await api(`/groups/${groupId}/messages`, { token: tokenC });
  check('非成员读取群消息被拒绝（403）', cRead.status === 403 && cRead.data.error.code === 'not_a_member', `status=${cRead.status}`);

  const cSend = await api(`/groups/${groupId}/messages`, { method: 'POST', token: tokenC, body: { text: '越权尝试' } });
  check('非成员发消息被拒绝（403）', cSend.status === 403, `status=${cSend.status}`);

  const bDissolve = await api(`/groups/${groupId}`, { method: 'DELETE', token: tokenB });
  check('普通成员解散群聊被拒绝（403）', bDissolve.status === 403, `status=${bDissolve.status}`);

  console.log('\n── 5. 实时收发（含延迟测量）──────────────────');
  const wsA = await openWs(tokenA);
  const wsB = await openWs(tokenB);
  await wsA.next(3000, (m) => m.type === 'ready');
  await wsB.next(3000, (m) => m.type === 'ready');
  wsA.send({ type: 'subscribe', groupId, sinceSeq: 0 });
  wsB.send({ type: 'subscribe', groupId, sinceSeq: 0 });
  const subA = await wsA.next(3000, (m) => m.type === 'subscribed');
  const subB = await wsB.next(3000, (m) => m.type === 'subscribed');
  check('两个账号均订阅成功', subA.groupId === groupId && subB.groupId === groupId);

  const latencies = [];
  for (let i = 1; i <= 3; i++) {
    const clientMsgId = `smoke-${i}-${Date.now()}`;
    const t0 = Date.now();
    wsA.send({ type: 'send', groupId, clientMsgId, text: `第 ${i} 条实时消息` });
    const ack = await wsA.next(3000, (m) => m.type === 'ack' && m.clientMsgId === clientMsgId);
    const got = await wsB.next(3000, (m) => m.type === 'message' && m.message.seq === ack.seq);
    latencies.push(Date.now() - t0);
    check(`消息 ${i} 送达对端并返回 ACK`, got.message.body === `第 ${i} 条实时消息`, `seq=${ack.seq}, 延迟=${Date.now() - t0}ms`);
  }
  const maxLatency = Math.max(...latencies);
  summary.latency.realtimeMaxMs = maxLatency;
  summary.latency.realtimeAll = latencies;
  check('实时投递延迟 < 2000ms', maxLatency < 2000, `max=${maxLatency}ms`);

  // 非成员无法订阅实时消息（服务端拒绝 + 入台账）
  const wsC = await openWs(tokenC);
  await wsC.next(3000, (m) => m.type === 'ready');
  wsC.send({ type: 'subscribe', groupId, sinceSeq: 0 });
  const cErr = await wsC.next(3000, (m) => m.type === 'error');
  check('非成员订阅实时消息被拒绝（not_a_member）', cErr.code === 'not_a_member', `code=${cErr.code}`);
  wsC.close();

  console.log('\n── 6. 幂等去重（重复提交）────────────────────');
  const dupId = `dup-${Date.now()}`;
  wsA.send({ type: 'send', groupId, clientMsgId: dupId, text: '重复提交测试' });
  const ack1 = await wsA.next(3000, (m) => m.type === 'ack' && m.clientMsgId === dupId);
  wsA.send({ type: 'send', groupId, clientMsgId: dupId, text: '重复提交测试' });
  const ack2 = await wsA.next(3000, (m) => m.type === 'ack' && m.clientMsgId === dupId);
  check('同一 clientMsgId 只落库一次', ack1.messageId === ack2.messageId, `id=${ack1.messageId}`);
  check('重复提交被标记为 duplicate', ack2.duplicate === true);

  console.log('\n── 7. 异常输入 ───────────────────────────────');
  const longText = 'x'.repeat(3000);
  const longId = `long-${Date.now()}`;
  wsA.send({ type: 'send', groupId, clientMsgId: longId, text: longText });
  const longErr = await wsA.next(3000, (m) => m.type === 'error');
  check('超长文本被拦截（text_too_long）', longErr.code === 'text_too_long', `code=${longErr.code}`);

  const emptyId = `empty-${Date.now()}`;
  wsA.send({ type: 'send', groupId, clientMsgId: emptyId, text: '   ' });
  const emptyErr = await wsA.next(3000, (m) => m.type === 'error');
  check('空消息被拦截（empty_message）', emptyErr.code === 'empty_message', `code=${emptyErr.code}`);

  const badUpload = await api('/uploads', {
    method: 'POST',
    token: tokenA,
    raw: Buffer.from('not-an-image'),
    headers: { 'content-type': 'text/plain', 'x-filename': 'x.txt' },
  });
  check('非法图片类型被拒绝（415）', badUpload.status === 415, `status=${badUpload.status}`);

  console.log('\n── 8. 限流 ───────────────────────────────────');
  let limited = 0;
  for (let i = 0; i < 40; i++) {
    const id = `burst-${Date.now()}-${i}`;
    wsA.send({ type: 'send', groupId, clientMsgId: id, text: `刷屏 ${i}` });
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try {
      const m = await wsA.next(300, (x) => x.type === 'error' && x.code === 'rate_limited');
      if (m.code === 'rate_limited') limited++;
    } catch {
      break;
    }
  }
  check('高频发送触发限流（rate_limited）', limited > 0, `拦截 ${limited} 条`);

  console.log('\n── 9. 断线重连补齐（不丢不重）────────────────');
  const before = await api(`/groups/${groupId}/messages?limit=100`, { token: tokenB });
  const seqBefore = before.data.latestSeq;
  wsB.close();
  await new Promise((r) => setTimeout(r, 200));
  // 断开期间 A 继续发消息
  wsA.send({ type: 'send', groupId, clientMsgId: `offline-${Date.now()}`, text: '断线期间的消息' });
  await wsA.next(3000, (m) => m.type === 'ack');
  const wsB2 = await openWs(tokenB);
  await wsB2.next(3000, (m) => m.type === 'ready');
  wsB2.send({ type: 'subscribe', groupId, sinceSeq: seqBefore });
  const replayMsgs = [];
  let subB2 = null;
  for (;;) {
    const m = await wsB2.next(2000);
    if (m.type === 'message') replayMsgs.push(m.message);
    if (m.type === 'subscribed') {
      subB2 = m;
      break;
    }
  }
  check('重连后补齐断线期间消息', replayMsgs.length === 1 && replayMsgs[0].body === '断线期间的消息', `补齐 ${replayMsgs.length} 条`);
  check('补齐消息序号连续且不重复', subB2.replayed === 1 && replayMsgs[0].seq === seqBefore + 1, `sinceSeq=${seqBefore} → seq=${replayMsgs[0]?.seq}`);

  const after = await api(`/groups/${groupId}/messages?limit=100`, { token: tokenB });
  const ids = new Set(after.data.messages.map((m) => m.id));
  check('消息列表无重复 ID', ids.size === after.data.messages.length, `总数=${after.data.messages.length}`);

  console.log('\n── 10. 历史分页 ──────────────────────────────');
  const page1 = await api(`/groups/${groupId}/messages?limit=5`, { token: tokenB });
  const page2 = await api(`/groups/${groupId}/messages?beforeSeq=${page1.data.messages[0].seq}&limit=5`, { token: tokenB });
  const overlap = page1.data.messages.some((m) => page2.data.messages.some((n) => n.id === m.id));
  check('向上翻页不重叠', !overlap && page2.data.messages.length > 0, `page1=${page1.data.messages.length}, page2=${page2.data.messages.length}`);

  console.log('\n── 11. 后台台账与可观测性 ────────────────────');
  const auditDenied = await api('/api/admin/audit?type=authz_denied', { token: undefined, headers: { 'x-admin-token': ADMIN_TOKEN } });
  check('越权拦截已入台账', auditDenied.status === 200 && auditDenied.data.records.length >= 3, `记录数=${auditDenied.data.records?.length}`);
  const auditRate = await api('/api/admin/audit?type=rate_limited', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  check('限流事件已入台账', auditRate.data.records.length > 0, `记录数=${auditRate.data.records.length}`);
  const auditChange = await api('/api/admin/audit?type=member_join', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  check('成员变更已入台账', auditChange.data.records.length >= 1);
  const exportCsv = await fetch(`${BASE}/api/admin/audit/export`, { headers: { 'x-admin-token': ADMIN_TOKEN } });
  const csv = await exportCsv.text();
  check('台账 CSV 导出可用', exportCsv.status === 200 && csv.includes('ts,type'), `长度=${csv.length}`);
  const metricsApi = await api('/api/admin/metrics', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  check('指标接口可用', metricsApi.status === 200 && metricsApi.data.metrics.counters['message.sent'] > 0, JSON.stringify(metricsApi.data.metrics.latencyMs));
  summary.counts.metricsCounters = metricsApi.data.metrics.counters;

  const badAdmin = await api('/api/admin/audit', { headers: { 'x-admin-token': 'wrong' } });
  check('错误管理令牌被拒绝（403）', badAdmin.status === 403, `status=${badAdmin.status}`);

  const dbMsgs = await api('/api/admin/messages', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  const realCount = (await api(`/groups/${groupId}/messages?limit=100`, { token: tokenA })).data.messages.length;
  const apiMsgsForGroup = dbMsgs.data.messages.filter((m) => m.group_id === groupId).length;
  check('数据库消息数与接口一致', apiMsgsForGroup === realCount, `db=${apiMsgsForGroup}, api=${realCount}`);

  console.log('\n── 12. 解散后消息不可访问 ────────────────────');
  const dissolve = await api(`/groups/${groupId}`, { method: 'DELETE', token: tokenA });
  check('群主解散群聊成功', dissolve.status === 200);
  const afterDissolve = await api(`/groups/${groupId}/messages`, { token: tokenB });
  check('解散后读取消息被拒绝（410）', afterDissolve.status === 410 && afterDissolve.data.error.code === 'group_dissolved', `status=${afterDissolve.status}`);
  const groupsAfter = await api('/groups', { token: tokenB });
  check('解散后群聊不再出现在列表中', groupsAfter.data.groups.every((g) => g.id !== groupId));

  wsA.close();
  wsB2.close();

  console.log('\n── 13. 审计台账统计 ──────────────────────────');
  const overview = await api('/api/admin/overview', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  summary.counts.finalTables = overview.data.counts;
  summary.counts.auditByType = overview.data.auditByType;
  check('总览接口返回表行数与审计分类', overview.status === 200 && overview.data.auditByType.length > 0, JSON.stringify(overview.data.counts));
} catch (err) {
  failures++;
  console.error('\n[FATAL] ' + (err?.stack || err));
} finally {
  shutdown();
  await new Promise((r) => setTimeout(r, 300));
}

console.log('\n════════════ 自检汇总 ════════════');
console.log(`通过 ${results.filter((r) => r.ok).length} / ${results.length}，失败 ${failures}`);
console.log('延迟样本:', JSON.stringify(summary.latency));
console.log('表行数:', JSON.stringify(summary.counts.finalTables || summary.counts.initialTables));
console.log('审计分类:', JSON.stringify(summary.counts.auditByType));
fs.writeFileSync(path.join(DATA_DIR, 'smoke-report.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`报告已写入: ${path.join(DATA_DIR, 'smoke-report.json')}`);
process.exit(failures ? 1 : 0);
