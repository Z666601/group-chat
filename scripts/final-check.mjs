// 交付前最后一轮功能复验（不动令牌、不重发牌，避免干扰运行中的桥接器）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const B = 'http://127.0.0.1:8787';
const OWNER = 'app_owner';
const PASS = 'app_owner_pass_123';
const GROUP = '多智能体讨论组（演示）';

async function api(p, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(B + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch { d = { raw: text }; }
  return { s: res.status, d };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {};

async function main() {
  // 1) 登录
  const login = await api('/api/auth/login', { method: 'POST', body: { username: OWNER, password: PASS } });
  if (login.s !== 200) throw new Error('登录失败：' + JSON.stringify(login.d));
  const tk = login.d.token;
  report.login = 'ok';

  // 2) 群与成员
  const groups = await api('/api/groups', { token: tk });
  const g = (groups.d.groups || []).find((x) => x.name === GROUP);
  if (!g) throw new Error('未找到群');
  const detail = await api('/api/groups/' + g.id, { token: tk });
  const agents = detail.d.members.filter((m) => m.kind === 'agent');
  report.group = { id: g.id, memberCount: detail.d.members.length, agents: agents.map((a) => `${a.displayName}(supportsModel=${a.supportsModel}, model=${a.model || '默认'})`) };

  // 3) 模型目录
  const cat = await api('/api/models', { token: tk });
  report.modelCount = cat.d.count;

  // 4) 真实切换一个模型
  const pick = (cat.d.models || []).find((m) => m.id === 'gpt-5.5') || (cat.d.models || [])[0];
  const patch = await api(`/api/groups/${g.id}/agents/autoclaw`, { method: 'PATCH', token: tk, body: { model: pick.id } });
  report.modelSwitch = { target: 'autoclaw', to: pick.id, status: patch.s };

  // 5) 发一条议题，触发各 Agent
  const topic = '最终验收：请各位用一句话说明自己是否在线。@AutoClaw @Hermes @Ekko Studio @ZCode @本机演示大脑';
  const posted = await api(`/api/groups/${g.id}/messages`, { method: 'POST', token: tk, body: { text: topic } });
  report.topicSeq = posted.d.message?.seq;

  // 6) 等待并回读
  await sleep(50000);
  const room = await api(`/api/groups/${g.id}/messages?limit=40`, { token: tk });
  report.room = room.d.messages.map((m) => ({
    seq: m.seq,
    who: `${m.senderKind === 'agent' ? '🤖' : '👤'} ${m.senderName}`,
    text: String(m.body).replace(/\n/g, ' ').slice(0, 70),
  }));

  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(ROOT, 'data', 'final-check.json'), JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('[final-check] 失败：', e?.message || e);
  process.exit(1);
});
