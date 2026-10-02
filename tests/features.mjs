// 新特性回归：引用回复 / 历史搜索 / aroundSeq 定位 / 智能体状态牌
// 用法：node --no-warnings tests/features.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.FEATURE_TEST_PORT || 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'feature-admin-token';
const DATA_DIR = path.join(ROOT, 'data', 'features');

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

async function api(p, { method = 'GET', body, token } = {}) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + (p.startsWith('/api') || p === '/healthz' ? p : '/api' + p), opts);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
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

function openAgentWs(agentToken) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?agentToken=${encodeURIComponent(agentToken)}`);
    const buffer = [];
    ws.addEventListener('message', (ev) => {
      try {
        buffer.push(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('open', () => {
      const next = (timeoutMs = 3000, filter = null) =>
        new Promise((resolve2, reject2) => {
          const deadline = Date.now() + timeoutMs;
          const tick = () => {
            const idx = filter ? buffer.findIndex(filter) : buffer.length ? 0 : -1;
            if (idx >= 0) return resolve2(buffer.splice(idx, 1)[0]);
            if (Date.now() > deadline) return reject2(new Error('ws timeout'));
            setTimeout(tick, 15);
          };
          tick();
        });
      resolve({
        ws,
        send: (obj) => ws.send(JSON.stringify(obj)),
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

// ── 启动被测服务 ─────────────────────────────────────
fs.rmSync(DATA_DIR, { recursive: true, force: true });
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
    server.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(failures ? 1 : 0), 200);
};
process.on('SIGINT', shutdown);

async function main() {
  if (!(await waitHealthy())) {
    console.error('服务未能启动');
    return shutdown();
  }

  // 准备：两个用户 + 一个群 + 邀请 bob
  const alice = (await api('/auth/register', { method: 'POST', body: { username: 'alice_f', password: 'password123', displayName: '爱丽丝' } })).data;
  const bob = (await api('/auth/register', { method: 'POST', body: { username: 'bob_f', password: 'password123', displayName: '鲍勃' } })).data;
  check('前置：两个账号注册成功', !!alice.token && !!bob.token);
  const created = (await api('/groups', { method: 'POST', body: { name: '特性验证群' }, token: alice.token })).data;
  const gid = created.group.id;
  const inv = (await api(`/groups/${gid}/invite`, { method: 'POST', token: alice.token })).data.inviteCode;
  await api('/groups/join', { method: 'POST', body: { inviteCode: inv }, token: bob.token });

  // ── 1. 引用回复 ──────────────────────────────────
  const root = (await api(`/groups/${gid}/messages`, { method: 'POST', body: { text: '这是被引用的原始消息' }, token: alice.token })).data;
  check('引用回复前置：根消息落库', root?.message?.id);

  const badReply = await api(`/groups/${gid}/messages`, { method: 'POST', body: { text: 'x', replyTo: 'msg_nonexistent' }, token: bob.token });
  check('引用回复：无效目标被拒', badReply.status === 400 && badReply.data.error?.code === 'reply_target_not_found');

  const replied = await api(`/groups/${gid}/messages`, { method: 'POST', body: { text: '这是引用回复', replyTo: root.message.id }, token: bob.token });
  check('引用回复：落库成功且带 replyTo', replied.status === 201 && replied.data.message.replyTo === root.message.id);
  check('引用回复：REST 视图带 replyPreview', replied.data.message.replyPreview?.body === '这是被引用的原始消息' && replied.data.message.replyPreview?.senderName === '爱丽丝');

  const page = (await api(`/groups/${gid}/messages?limit=30`, { token: bob.token })).data;
  const pageHit = (page.messages || []).find((m) => m.replyTo === root.message.id);
  check('引用回复：历史分页视图带预览', !!pageHit && pageHit.replyPreview?.seq > 0);

  // ── 2. 历史搜索 ──────────────────────────────────
  await api(`/groups/${gid}/messages`, { method: 'POST', body: { text: '荧光蓝俱乐部公约第一条' }, token: alice.token });
  const hit = await api(`/groups/${gid}/search?q=荧光蓝`, { token: bob.token });
  check('搜索：关键词命中', hit.status === 200 && (hit.data.messages || []).some((m) => m.body.includes('荧光蓝')));
  const miss = await api(`/groups/${gid}/search?q=${encodeURIComponent('不存在的词xyz')}`, { token: bob.token });
  check('搜索：无结果返回空数组', miss.status === 200 && miss.data.messages?.length === 0);
  const emptyQ = await api(`/groups/${gid}/search?q=%20`, { token: bob.token });
  check('搜索：空关键词被拒', emptyQ.status === 400);
  const outsiderToken = (await api('/auth/register', { method: 'POST', body: { username: 'eve_f', password: 'password123', displayName: '路人' } })).data.token;
  const outsider = await api(`/groups/${gid}/search?q=荧光蓝`, { token: outsiderToken });
  check('搜索：非成员被拒（403）', outsider.status === 403);

  // ── 3. aroundSeq 定位窗口 ────────────────────────
  for (let i = 0; i < 40; i++) {
    await api(`/groups/${gid}/messages`, { method: 'POST', body: { text: `批量消息 ${i}` }, token: alice.token });
  }
  const around = await api(`/groups/${gid}/messages?aroundSeq=25&limit=10`, { token: bob.token });
  const seqs = (around.data.messages || []).map((m) => m.seq);
  check('aroundSeq：返回包含目标 seq 的窗口', seqs.includes(25) && seqs.length === 10);

  // ── 4. 智能体状态牌 ──────────────────────────────
  const agRes = await fetch(`${BASE}/api/admin/agents`, {
    method: 'POST',
    headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ groupId: gid, agentKey: 'demo', displayName: '演示大脑', avatar: '🤖' }),
  });
  const ag = await agRes.json();
  check('状态牌前置：agent 签发成功', !!ag.token);

  const agentWs = await openAgentWs(ag.token);
  await agentWs.next(3000, (m) => m.type === 'ready');
  agentWs.send({ type: 'subscribe', groupId: gid, sinceSeq: 0 });
  await agentWs.next(3000, (m) => m.type === 'subscribed');
  agentWs.send({ type: 'agent-status', status: 'unavailable', reason: '网关额度耗尽 402' });
  const pres = await agentWs.next(3000, (m) => m.type === 'presence' && m.agentStatus?.[ag.userId]?.status === 'unavailable');
  const st = pres.agentStatus?.[ag.userId];
  check('状态牌：presence 广播携带缺席原因', st?.status === 'unavailable' && String(st.reason || '').includes('402'));

  const detail = (await api(`/groups/${gid}`, { token: bob.token })).data;
  check('状态牌：群详情接口携带 agentStatus', detail.agentStatus?.[ag.userId]?.status === 'unavailable');

  agentWs.send({ type: 'agent-status', status: 'ok' });
  const pres2 = await agentWs.next(3000, (m) => m.type === 'presence' && m.agentStatus?.[ag.userId]?.status === 'ok');
  check('状态牌：恢复在岗可回写 ok', !!pres2);
  agentWs.close();

  console.log(`\n结果：${results.length - failures}/${results.length} 通过，${failures} 失败`);
  shutdown();
}

main();
