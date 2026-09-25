// 一键演示：登录 → 确保讨论组 → 发牌 → 发议题 → 回读房间内容
// 用法：node --no-warnings scripts/demo-run.mjs [--group="多智能体讨论组（演示）"]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'agents.config.json'), 'utf8'));
const SERVER = process.env.SERVER || config.server || 'http://127.0.0.1:8787';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : args[args.indexOf(hit) + 1] ?? d;
};
const GROUP_NAME = argOf('group', '多智能体讨论组（演示）');
const OWNER = 'app_owner';
const PASS = 'app_owner_pass_123';

const TOKEN_FILE = path.join(ROOT, 'agents', '.tokens.local.json');
const ADMIN_FILE = process.env.ADMIN_TOKEN_FILE || path.join(ROOT, 'agents', '.admin.token');

async function api(p, { method = 'GET', body, token, admin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-token'] = fs.readFileSync(ADMIN_FILE, 'utf8').trim();
  const res = await fetch(SERVER + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const health = await api('/healthz');
  if (health.status !== 200) throw new Error('服务未就绪：' + SERVER);

  // 登录（失败则注册）
  let login = await api('/api/auth/login', { method: 'POST', body: { username: OWNER, password: PASS } });
  if (login.status !== 200) {
    login = await api('/api/auth/register', {
      method: 'POST',
      body: { username: OWNER, password: PASS, displayName: '讨论组管理员' },
    });
  }
  if (login.status !== 200 && login.status !== 201) throw new Error('登录失败：' + JSON.stringify(login.data));
  const ownerToken = login.data.token;
  console.log('✓ 已登录', OWNER);

  // 找/建群
  const groups = await api('/api/groups', { token: ownerToken });
  let group = (groups.data.groups || []).find((g) => g.name === GROUP_NAME);
  if (!group) {
    const created = await api('/api/groups', { method: 'POST', token: ownerToken, body: { name: GROUP_NAME, avatar: '🧠' } });
    group = created.data.group;
    console.log('✓ 已创建群', group.name);
  } else {
    console.log('✓ 复用群', group.name);
  }

  // 发牌
  const tokens = {};
  const agentNames = [];
  for (const a of config.agents) {
    const r = await api('/api/admin/agents', {
      method: 'POST',
      admin: true,
      body: { groupId: group.id, agentKey: a.key, displayName: a.name, avatar: a.avatar },
    });
    if (r.status !== 201) throw new Error(`发放 ${a.key} 失败：` + JSON.stringify(r.data));
    tokens[a.key] = r.data.token;
    agentNames.push(a.name);
  }
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ server: SERVER, groupId: group.id, groupName: group.name, ownerToken, agentNames, tokens }, null, 2),
  );
  console.log('✓ 已发放', config.agents.length, '个 Agent 令牌');

  // 发议题
  const topic = argOf('topic', '上线前最后一个议题：这套群聊系统还差什么？@AutoClaw @Hermes @Ekko Studio @ZCode 各给一条最关键意见。');
  const posted = await api(`/api/groups/${group.id}/messages`, { method: 'POST', token: ownerToken, body: { text: topic } });
  console.log('✓ 议题已发出 seq=' + posted.data.message.seq);

  const waitMs = Number(argOf('wait', '50000'));
  console.log(`… 等待 ${Math.round(waitMs / 1000)}s 让各 Agent 回应`);
  await sleep(waitMs);

  const room = await api(`/api/groups/${group.id}/messages?limit=40`, { token: ownerToken });
  console.log('\n── 房间内容 ─────────────────────────────');
  for (const m of room.data.messages) {
    console.log(`[${m.seq}] ${m.senderKind === 'agent' ? '🤖' : '👤'} ${m.senderName}: ` + String(m.body).replace(/\n/g, ' ⏎ ').slice(0, 96));
  }
  const detail = await api(`/api/groups/${group.id}`, { token: ownerToken });
  console.log('\n成员:', detail.data.members.map((m) => `${m.displayName}(${m.kind})`).join(' · '));
  console.log('群聊地址:', SERVER, '| 账号:', OWNER, '/', PASS);
}

main().catch((e) => {
  console.error('[demo] 失败：', e?.message || e);
  process.exit(1);
});
