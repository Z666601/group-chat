// 为「多智能体讨论组」发放 Agent 入群令牌（幂等，可反复执行）
// 用法：node agents/provision.mjs [--owner=app_owner]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.GC_AGENTS_CONFIG || path.join(__dirname, 'agents.config.json');
const TOKENS_PATH = process.env.GC_TOKENS_FILE || path.join(__dirname, '.tokens.local.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const SERVER = process.env.SERVER || config.server || 'http://127.0.0.1:8787';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : args[args.indexOf(hit) + 1] ?? d;
};
const OWNER = argOf('owner', 'app_owner');
const OWNER_PASSWORD = argOf('password', 'app_owner_pass_123');
const GROUP_NAME = argOf('group', '多智能体讨论组');

function adminToken() {
  const f = process.env.ADMIN_TOKEN_FILE || path.join(__dirname, '.admin.token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return process.env.ADMIN_TOKEN || '';
}

async function api(p, { method = 'GET', body, token, admin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-token'] = adminToken();
  const res = await fetch(SERVER + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function main() {
  // 1) 健康检查
  const health = await api('/healthz');
  if (health.status !== 200) throw new Error('服务未就绪：' + SERVER);

  // 2) 准备一个人类拥有者账号（用于建群）
  let login = await api('/api/auth/login', { method: 'POST', body: { username: OWNER, password: OWNER_PASSWORD } });
  if (login.status !== 200) {
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: { username: OWNER, password: OWNER_PASSWORD, displayName: '讨论组管理员' },
    });
    if (reg.status !== 201) throw new Error('创建拥有者账号失败：' + JSON.stringify(reg.data));
    login = reg;
  }
  const ownerToken = login.data.token;

  // 3) 找/建群
  const groups = await api('/api/groups', { token: ownerToken });
  let group = (groups.data.groups || []).find((g) => g.name === GROUP_NAME);
  if (!group) {
    const created = await api('/api/groups', {
      method: 'POST',
      token: ownerToken,
      body: { name: GROUP_NAME, avatar: '🧠' },
    });
    if (created.status !== 201) throw new Error('建群失败：' + JSON.stringify(created.data));
    group = created.data.group;
    console.log('已创建群：', group.name, group.id);
  } else {
    console.log('复用已有群：', group.name, group.id);
  }

  // 4) 逐个发放 Agent 令牌
  const tokens = {};
  const agentNames = [];
  for (const a of config.agents) {
    const r = await api('/api/admin/agents', {
      method: 'POST',
      admin: true,
      body: {
        groupId: group.id,
        agentKey: a.key,
        displayName: a.name,
        avatar: a.avatar,
        supportsModel: a.supportsModel !== false,
      },
    });
    if (r.status !== 201) throw new Error(`发放 ${a.key} 失败：` + JSON.stringify(r.data));
    tokens[a.key] = r.data.token;
    agentNames.push(a.name);
    console.log('  ✓ 已发放', a.key, '→', a.name);
  }

  fs.writeFileSync(
    TOKENS_PATH,
    JSON.stringify({ server: SERVER, groupId: group.id, groupName: group.name, ownerToken, agentNames, tokens }, null, 2),
  );
  console.log('\n令牌已写入', TOKENS_PATH);
  console.log('群组：', group.name, `(${group.id})`);
  console.log('群聊地址：', SERVER, '（登录', OWNER, '/', OWNER_PASSWORD, '）');
}

main().catch((err) => {
  console.error('[provision] 失败：', err?.message || err);
  process.exit(1);
});
