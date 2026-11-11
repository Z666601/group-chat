import fs from 'node:fs';
import path from 'node:path';

// 一次性发言器：以指定 Agent 身份经 WS 发一条消息后退出
// 用法：node agents/group-say.mjs --key=zcode --text="..."
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const argOf = (n, d = null) => {
  const hit = process.argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : process.argv[process.argv.indexOf(hit) + 1] ?? d;
};
const key = argOf('key');
const text = argOf('text');
const group = argOf('group'); // 可选：默认主群；私聊传 dm.<agentKey>（如 dm.lanky）
if (!key || !text) {
  console.error('用法: node agents/group-say.mjs --key=<agentKey> --text="内容" [--group=主群ID|dm.<agentKey>]');
  process.exit(1);
}
const tokensFile = JSON.parse(fs.readFileSync(process.env.GC_TOKENS_FILE || path.join(ROOT, 'agents', '.tokens.local.json'), 'utf8'));
const token = tokensFile.tokens[key];
let groupId = group || tokensFile.groupId;
if (group && group.startsWith('dm.')) groupId = tokensFile.dm[group.slice(3)]?.groupId;
if (!token || !groupId) { console.error('令牌或群不存在'); process.exit(1); }
const server = (tokensFile.server || 'http://127.0.0.1:8787').replace(/^http/, 'ws');
const ws = new WebSocket(`${server}/ws?agentToken=${encodeURIComponent(token)}`);
const done = (code, msg) => { try { ws.close(); } catch {} console.log(msg); process.exit(code); };
const timer = setTimeout(() => done(1, '超时'), 15000);
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'send', groupId, clientMsgId: `say-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'ready' && !m.user) { clearTimeout(timer); return done(2, `鉴权失败：${m.error}`); }
  if (m.type === 'ack') { clearTimeout(timer); return done(0, `已发言（seq=${m.seq}）`); }
  if (m.type === 'error') { clearTimeout(timer); return done(3, `拒绝：${m.code} ${m.message}`); }
});
ws.addEventListener('error', () => { clearTimeout(timer); done(1, 'WS 连接失败'); });
