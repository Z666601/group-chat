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
      const next = async (timeoutMs = 3000, filter = null) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const idx = filter ? buffer.findIndex(filter) : buffer.length ? 0 : -1;
          if (idx >= 0) return buffer.splice(idx, 1)[0];
          if (Date.now() > deadline) throw new Error('ws timeout waiting for message');
          await new Promise((r) => setTimeout(r, 15));
        }
      };
      resolve({
        ws,
        send: (obj) => ws.send(JSON.stringify(obj)),
        // 发一条并等 ack，返回是否落库（被限流/拒绝时返回 false）
        sendNow: async (groupId, text, timeoutMs = 3000) => {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          ws.send(JSON.stringify({ type: 'send', groupId, clientMsgId: id, text }));
          try {
            return (await next(timeoutMs, (m) => m.type === 'ack' && m.clientMsgId === id)).ok !== false;
          } catch {
            return false;
          }
        },
        buffer,
        // 轮询缓冲取第一条匹配消息（取走后从缓冲移除），超时抛错
        next,
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
    LOCAL_AUTOLOGIN_USER: 'alice',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => {
  const s = String(d);
  if (!s.includes('ExperimentalWarning')) process.stderr.write('[server] ' + s);
});

// 自检临时拉起的桥接器/启动器 PID：Windows 上子进程不随父退出，必须在收尾统一清掉
const spawnedPids = [];
const shutdown = () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid);
    } catch {
      /* ignore */
    }
  }
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

  console.log('\n── 10b. 已读回执与未读分割线 ─────────────────');
  const readSeq = page1.data.latestSeq;
  wsB2.send({ type: 'read', groupId, seq: readSeq });
  let receipt = null;
  try {
    receipt = await wsA.next(3000, (m) => m.type === 'read-receipt' && m.userId === userB.id);
  } catch {
    /* 未收到 */
  }
  check('已读上报会广播 read-receipt 给他人', !!receipt && receipt.seq === readSeq, receipt ? `seq=${receipt.seq}` : '未收到');
  const detailAfterRead = await api(`/groups/${groupId}`, { token: tokenA });
  const memberB = (detailAfterRead.data.members || []).find((m) => m.id === userB.id);
  check('群详情成员的 lastReadSeq 已推进', Number(memberB?.lastReadSeq) >= readSeq, `lastReadSeq=${memberB?.lastReadSeq}`);
  // 回退的 read 不应再广播
  wsB2.send({ type: 'read', groupId, seq: 1 });
  let echo = null;
  try {
    echo = await wsA.next(800, (m) => m.type === 'read-receipt' && m.userId === userB.id);
  } catch {
    /* 预期不收到 */
  }
  check('游标回退的 read 不重复广播', echo === null);
  const listB = await api('/groups', { token: tokenB });
  const rowB = (listB.data.groups || []).find((g) => g.id === groupId);
  check('未读数与 last_read_seq 一致', Number(rowB?.unread) === Math.max(0, Number(rowB?.latestSeq) - readSeq), `unread=${rowB?.unread}`);

  console.log('\n── 10c. 断线期间收到消息后游标不错位 ────────');
  // B 断开（wsB2）→ A 在 B 离线期间连发两条 → B 带 sinceSeq 重连补齐并上报已读。
  const bBefore = await api(`/groups/${groupId}/messages?limit=100`, { token: tokenB });
  const localView = bBefore.data.messages.slice();
  const bSince = bBefore.data.latestSeq;
  wsB2.close();
  await new Promise((r) => setTimeout(r, 900));
  const offA1 = await wsA.sendNow(groupId, 'B离线·第一条');
  const offA2 = await wsA.sendNow(groupId, 'B离线·第二条');
  const bLatest = (await api(`/groups/${groupId}/messages?limit=1`, { token: tokenB })).data.latestSeq;
  const wsB3 = await openWs(tokenB);
  await wsB3.next(3000, (m) => m.type === 'ready');
  wsB3.send({ type: 'subscribe', groupId, sinceSeq: bSince });
  const bReplay = [];
  for (;;) {
    const m = await wsB3.next(2500);
    if (m.type === 'message') bReplay.push(m.message);
    if (m.type === 'subscribed') break;
  }
  const merged = localView.concat(bReplay);
  check(
    '重连补齐的条数与离线期间一致',
    bReplay.length === bLatest - bSince && bReplay.length === 2,
    `离线期 ack=${offA1}/${offA2}, since=${bSince}, latest=${bLatest}, 补齐=${bReplay.length}`,
  );
  check(
    '补齐与离线前视图合并后无重复 seq/id',
    new Set(merged.map((m) => m.seq)).size === merged.length && new Set(merged.map((m) => m.id)).size === merged.length,
    `合并=${merged.length}, 唯一seq=${new Set(merged.map((m) => m.seq)).size}`,
  );
  check('补齐的 seq 是断线后的连续尾段', bReplay.every((m, i) => m.seq === bSince + i + 1), `${bReplay.map((m) => m.seq).join(',')}`);
  const lastBSeq = bReplay.length ? bReplay[bReplay.length - 1].seq : bSince;
  wsB3.send({ type: 'read', groupId, seq: lastBSeq });
  await new Promise((r) => setTimeout(r, 250));
  const detailB = await api(`/groups/${groupId}`, { token: tokenA });
  const memberB2 = (detailB.data.members || []).find((m) => m.id === userB.id);
  check('离线重连后 last_read_seq 精确等于 latestSeq', Number(memberB2?.lastReadSeq) === bLatest, `lastReadSeq=${memberB2?.lastReadSeq}, latest=${bLatest}`);
  const listB2 = await api('/groups', { token: tokenB });
  const rowB2 = (listB2.data.groups || []).find((g) => g.id === groupId);
  check('补齐并上报后本人未读归零', Number(rowB2?.unread) === 0, `unread=${rowB2?.unread}`);
  // 同一游标再报一次不应再向他人广播（前端「已读 x/n」只应变化一次）
  const isBReceipt = (m) => m.type === 'read-receipt' && m.userId === userB.id;
  let firstReceipt = null;
  try {
    firstReceipt = await wsA.next(2000, isBReceipt);
  } catch {
    /* 未收到 */
  }
  check('补齐后的首次 read 只广播一条回执', !!firstReceipt && firstReceipt.seq === lastBSeq, firstReceipt ? `seq=${firstReceipt.seq}` : '未收到');
  wsB3.send({ type: 'read', groupId, seq: lastBSeq });
  let dupReceipt = null;
  try {
    dupReceipt = await wsA.next(900, isBReceipt);
  } catch {
    /* 预期收不到 */
  }
  check('同游标重复 read 帧不再二次广播', dupReceipt === null);
  wsB3.close();

  // 回归防护：从 AI 会话终端拉起桥接器时，SDK 入口标记会让 qoderclicn 以 exit=4 崩掉
  const probeOut = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', 'agents/bridge.mjs', '--key=__probe__'], {
      cwd: ROOT,
      env: {
        ...process.env,
        QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts',
        QODER_AGENT_SDK_VERSION: '1.0.48',
        QODERCLI_RUNTIME_PACKAGING: 'worker_mjs',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('close', () => resolve(out));
  });
  check(
    '桥接器启动即剥离 Qoder SDK 污染变量',
    /已剥离 SDK 污染变量/.test(probeOut)
      && probeOut.includes('QODER_AGENT_SDK_ENTRYPOINT')
      && probeOut.includes('QODER_AGENT_SDK_VERSION')
      && probeOut.includes('QODERCLI_RUNTIME_PACKAGING'),
    probeOut.split('\n')[0].slice(0, 80),
  );

  console.log('\n── 10d. 桥接器多开防重（start-all 幂等）──────');
  // 双开「启动群聊」会起两套桥接器 → 同一条议题每人回两遍。
  // 这里用 GC_* 缝隙把配置/令牌/PID 表指向临时文件，确保自检绝不碰真实状态与真实服务。
  {
    const dir = path.join(DATA_DIR, 'agents-probe');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, 'agents.config.json');
    const tokPath = path.join(dir, 'tokens.local.json');
    const pidPath = path.join(dir, 'bridge-pids.json');
    const mkAgent = (key, name, avatar) => ({
      key, name, avatar, trigger: 'mention', replyToAgents: false, supportsModel: false, brain: { type: 'local' },
    });
    // 探针丙：命令大脑「stdout 空 + exit≠0」的失败样本（node 自身，零成本、零外部依赖），
    // 用来钉住 D② 那条契约——失败必须在群里说人话，不能静默、也不能把原始报错贴进群。
    const PROBE_FAIL_SPEECH = '无法应答：探针大脑暂不可用（自检固定话术）';
    const PROBE_KEYS = ['probea', 'probeb', 'probecmd'];
    const allOnline = async () => {
      const on = await onlineKeys();
      return PROBE_KEYS.every((k) => on.has(k));
    };
    const agents = [
      mkAgent('probea', '探针甲', '🅰️'),
      mkAgent('probeb', '探针乙', '🅱️'),
      {
        key: 'probecmd', name: '探针丙', avatar: '🅲', trigger: 'mention', replyToAgents: false, supportsModel: false,
        unavailable: PROBE_FAIL_SPEECH,
        brain: { type: 'cmd', command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 20000 },
      },
    ];
    fs.writeFileSync(cfgPath, JSON.stringify({ server: BASE, agents }, null, 2));
    const PENV = {
      ...process.env,
      SERVER: BASE,
      ADMIN_TOKEN,
      // 指向不存在的路径，避开真实 agents/.admin.token（provision 优先读文件）
      ADMIN_TOKEN_FILE: path.join(dir, 'no-such-admin.token'),
      GC_AGENTS_CONFIG: cfgPath,
      GC_TOKENS_FILE: tokPath,
      GC_BRIDGE_PIDS: pidPath,
      LOG_LEVEL: 'silent',
    };
    const drain = (c) => {
      let out = '';
      c.stdout.on('data', (d) => (out += String(d)));
      c.stderr.on('data', (d) => (out += String(d)));
      return () => out;
    };
    const readPidTable = () => {
      try {
        const pids = JSON.parse(fs.readFileSync(pidPath, 'utf8')).pids || [];
        for (const p of pids) if (!spawnedPids.includes(p.pid)) spawnedPids.push(p.pid);
        return pids;
      } catch {
        return [];
      }
    };
    // 超时也要有结论：幂等回归时第二轮 start-all 会一直不起新桥也不退出，不能把自检挂死
    const runUntilExit = (script, argv = [], timeoutMs = 20000) =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ['--no-warnings', script, ...argv], {
          cwd: ROOT, env: PENV, stdio: ['ignore', 'pipe', 'pipe'],
        });
        spawnedPids.push(c.pid);
        const getOut = drain(c);
        const timer = setTimeout(() => {
          try { c.kill(); } catch {}
          resolve({ code: null, out: getOut(), timedOut: true });
        }, timeoutMs);
        c.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, out: getOut(), timedOut: false });
        });
      });

    const realTok = path.join(ROOT, 'agents', '.tokens.local.json');
    const realPids = path.join(ROOT, 'data', 'bridge-pids.json');
    const fingerprint = (f) => {
      try {
        const s = fs.statSync(f);
        return `${s.size}:${Math.round(s.mtimeMs)}`;
      } catch {
        return 'missing';
      }
    };
    const fpTokBefore = fingerprint(realTok);
    const fpPidBefore = fingerprint(realPids);

    const prov = await runUntilExit('agents/provision.mjs', ['--group=自检探针群', '--owner=probe_owner', '--password=probe_pass_123']);
    check('探针群发放令牌成功（provision 走 GC_TOKENS_FILE）', prov.code === 0, `code=${prov.code} ${prov.out.slice(-90).replace(/\s+/g, ' ')}`);
    check('真实令牌文件未被自检改写', fingerprint(realTok) === fpTokBefore, `${fpTokBefore} → ${fingerprint(realTok)}`);

    const sa1 = spawn(process.execPath, ['--no-warnings', 'agents/start-all.mjs'], {
      cwd: ROOT, env: PENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    spawnedPids.push(sa1.pid);
    drain(sa1);

    const tokens = JSON.parse(fs.readFileSync(tokPath, 'utf8'));
    const onlineKeys = async () => {
      const r = await api(`/groups/${tokens.groupId}`, { token: tokens.ownerToken });
      return new Set((r.data.members || []).filter((m) => m.online && m.agentKey).map((m) => m.agentKey));
    };
    let on = new Set();
    for (let i = 0; i < 40; i++) {
      on = await onlineKeys();
      if (await allOnline()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('首轮 start-all 起满三个探针桥接器', await allOnline(), [...on].join(','));
    const pidBefore = readPidTable();

    const sa2 = await runUntilExit('agents/start-all.mjs', [], 8000);
    check('第二轮 start-all 不重复起桥、自行退出', !sa2.timedOut && sa2.code === 0, `code=${sa2.code} timedOut=${sa2.timedOut}`);
    check(
      '第二轮明确跳过存活的三个 key',
      /已在运行，跳过：probea/.test(sa2.out) && /probeb\(pid/.test(sa2.out) && /probecmd\(pid/.test(sa2.out),
      (sa2.out.match(/已在运行.*/) || [''])[0].slice(0, 70),
    );
    const pidAfter = readPidTable();
    check(
      'PID 表未翻倍（仍是 3 条且 pid 与首轮相同）',
      pidAfter.length === 3 && pidAfter.every((p) => pidBefore.some((q) => q.key === p.key && q.pid === p.pid)),
      JSON.stringify(pidAfter.map((p) => `${p.key}:${p.pid === pidBefore.find((q) => q.key === p.key)?.pid ? 'same' : 'NEW'}`)),
    );
    check('真实 PID 表未被自检改写', fingerprint(realPids) === fpPidBefore, `${fpPidBefore} → ${fingerprint(realPids)}`);

    const post = await api(`/groups/${tokens.groupId}/messages`, {
      method: 'POST', token: tokens.ownerToken, body: { text: '请探针甲与探针乙就「上线风险」各说一句' },
    });
    check('向探针群发议题成功', post.status === 201 || post.status === 200, `status=${post.status}`);
    const agentCounts = async () => {
      const r = await api(`/groups/${tokens.groupId}/messages?limit=100`, { token: tokens.ownerToken });
      const ms = (r.data.messages || []).filter((m) => m.senderKind === 'agent');
      return { a: ms.filter((m) => m.senderName === '探针甲').length, b: ms.filter((m) => m.senderName === '探针乙').length };
    };
    let got = { a: 0, b: 0 };
    for (let i = 0; i < 40; i++) {
      got = await agentCounts();
      if (got.a >= 1 && got.b >= 1) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 2500)); // 再等一会：多开的话重复回帖此刻早已落库
    const counted = await agentCounts();
    check(
      '连起两次 start-all 后每个 Agent 只回一条',
      counted.a === 1 && counted.b === 1,
      `甲=${counted.a} 乙=${counted.b}`,
    );
    // 未点名的 Agent 必须保持沉默（否则群里全是噪声）
    const silentCmd = (await api(`/groups/${tokens.groupId}/messages?limit=100`, { token: tokens.ownerToken }))
      .data.messages.filter((m) => m.senderName === '探针丙');
    check('没被点名的命令大脑探针保持沉默', silentCmd.length === 0, `丙=${silentCmd.length}`);

    // D② 契约：cmd 大脑 exit≠0 且 stdout 为空时，要在群里说人话（固定兜底话术），
    // 既不静默、也不把「exit=3 / 大脑未返回内容」这类原始报错贴进群。
    const postFail = await api(`/groups/${tokens.groupId}/messages`, {
      method: 'POST', token: tokens.ownerToken, body: { text: '请探针丙回一句' },
    });
    let failMsgs = [];
    for (let i = 0; i < 40 && postFail.status < 300; i++) {
      const r = await api(`/groups/${tokens.groupId}/messages?limit=100`, { token: tokens.ownerToken });
      failMsgs = (r.data.messages || []).filter((m) => m.senderName === '探针丙');
      if (failMsgs.length) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    check(
      '命令大脑失败时群里给出可读兜底说明（非静默）',
      failMsgs.length === 1 && failMsgs[0].body === PROBE_FAIL_SPEECH,
      `丙=${failMsgs.length} 原文=${JSON.stringify(String(failMsgs[0]?.body ?? '').slice(0, 40))}`,
    );
    check(
      '原始报错未泄漏进群聊',
      failMsgs.every((m) => !/exit=|未返回内容|ENOENT|Error:/.test(m.body || '')),
      (failMsgs[0]?.body || '').slice(0, 20),
    );

    // 掉线自愈：杀掉一个桥接器，下一轮只该补它，不能被「pid 表里有活的」一刀切跳过
    const beforeKill = readPidTable();
    check('两轮后 PID 表仍如实记录三条活口', beforeKill.length === 3, JSON.stringify(beforeKill));
    const victim = beforeKill.find((p) => p.key === 'probeb');
    if (victim) {
      try { process.kill(victim.pid); } catch {}
    }
    for (let i = 0; i < 20; i++) {
      if (!(await onlineKeys()).has('probeb')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // 这一轮有活要干（补起 probeb），所以 start-all 会驻留守护子进程，不能等它退出
    const sa3 = spawn(process.execPath, ['--no-warnings', 'agents/start-all.mjs'], {
      cwd: ROOT, env: PENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    spawnedPids.push(sa3.pid);
    const sa3Out = drain(sa3);
    let healed = false;
    for (let i = 0; i < 40; i++) {
      if ((await onlineKeys()).has('probeb')) { healed = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    const pid3 = readPidTable();
    const revived = pid3.find((p) => p.key === 'probeb');
    const kept = pid3.find((p) => p.key === 'probea');
    check(
      '桥接器掉线后下一轮只补起死掉的那个',
      /已在运行，跳过：probea/.test(sa3Out())
        && pid3.length === 3
        && !!revived && !!victim && revived.pid !== victim.pid
        && !!kept && kept.pid === beforeKill.find((p) => p.key === 'probea')?.pid,
      (sa3Out().match(/已在运行.*/) || [''])[0].slice(0, 70),
    );
    check('补起的桥接器重新上线', healed);

    for (const p of readPidTable()) {
      try { process.kill(p.pid); } catch {}
    }
    try { sa1.kill(); } catch {}
  }

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

  console.log('\n── 14. 本机免密进入与前端可见性回归 ──────────');
  const localOn = await api('/auth/local', { method: 'POST', body: {} });
  check('本机回环可免密进入（200 且带 token）', localOn.status === 200 && localOn.data.token, `status=${localOn.status}`);
  const meLocal = await api('/me', { token: localOn.data?.token });
  check('免密会话取到的就是本机指定账号', meLocal.status === 200 && meLocal.data.user.username === 'alice', JSON.stringify(meLocal.data?.user || {}));
  const spoofed = await api('/auth/local', { method: 'POST', body: {}, headers: { 'x-forwarded-for': '8.8.8.8' } });
  check('伪造 X-Forwarded-For 改变不了本机判定（仍按 socket 远端）', spoofed.status === 200, `status=${spoofed.status}`);

  const offDir = path.join(ROOT, 'data', 'smoke-off');
  fs.rmSync(offDir, { recursive: true, force: true });
  const offServer = spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT + 1),
      HOST: '127.0.0.1',
      DATA_DIR: offDir,
      ADMIN_TOKEN,
      LOG_LEVEL: 'silent',
      LOCAL_AUTOLOGIN: '0',
      LOCAL_AUTOLOGIN_USER: 'alice',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawnedPids.push(offServer.pid);
  let offReady = false;
  for (let i = 0; i < 60 && !offReady; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      offReady = (await fetch(`http://127.0.0.1:${PORT + 1}/healthz`)).status === 200;
    } catch {
      /* 未就绪 */
    }
  }
  const offRes = await fetch(`http://127.0.0.1:${PORT + 1}/api/auth/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('LOCAL_AUTOLOGIN=0 时免密入口关闭（404）', offReady && offRes.status === 404, `ready=${offReady} status=${offRes.status}`);

  const cssText = fs.readFileSync(path.join(ROOT, 'web', 'styles.css'), 'utf8');
  check('样式表让 hidden 属性真正生效（登录页不再浮在界面上挡按钮）', /\[hidden\][^}]*display:\s*none\s*!important/s.test(cssText));
  const appJsText = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  check('前端启动先试本机免密、失败才回落到密码表单', appJsText.includes('async function localAutologin') && /if \(await localAutologin\(\)\) return;/.test(appJsText));
  const qbrainText = fs.readFileSync(path.join(ROOT, 'agents', 'qoder-brain.mjs'), 'utf8');
  const formsBlock = (qbrainText.split('const ARG_FORMS')[1] || '').split('];')[0];
  const firstForm = (formsBlock.split('\n').find((l) => l.trim().startsWith('(p) =>')) || '').trim();
  const readonlyLine = (qbrainText.split('\n').find((l) => l.includes('const READONLY_TOOLS')) || '').trim();
  check(
    'Qoder 大脑首选调用形式带 auto 权限（default/dont_ask 下 CLI 不执行工具，会把工具调用当正文吐进群）',
    firstForm.includes("'--permission-mode', 'auto'") && firstForm.includes('...READONLY_TOOLS'),
    firstForm,
  );
  check(
    'Qoder 大脑的工具白名单只读（Read/Glob/Grep，不含写入与命令）',
    /^const READONLY_TOOLS = \['--tools', 'Read', 'Glob', 'Grep'\];$/.test(readonlyLine),
    readonlyLine,
  );
  const ovLocal = await api('/api/admin/overview', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  check('免密进入留有审计记录', JSON.stringify(ovLocal.data || {}).includes('login_local'), `status=${ovLocal.status}`);
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
