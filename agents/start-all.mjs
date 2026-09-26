// 一次性拉起所有 Agent 桥接器（幂等：key 已在跑就跳过，可重复执行）
// 用法：node agents/start-all.mjs [--only=hermes,ekko] [--once=开局语]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// GC_* 环境变量是自检（tests/smoke.mjs）用的隔离缝隙：把配置/令牌/PID 表指到临时文件，
// 自检跑 start-all 就不会碰用户真实的 agents/.tokens.local.json 与 data/bridge-pids.json。
const CONFIG_PATH = process.env.GC_AGENTS_CONFIG || path.join(__dirname, 'agents.config.json');
const TOKENS_PATH = process.env.GC_TOKENS_FILE || path.join(__dirname, '.tokens.local.json');
const PIDS_PATH = process.env.GC_BRIDGE_PIDS || path.join(ROOT, 'data', 'bridge-pids.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : args[args.indexOf(hit) + 1] ?? d;
};
const only = (argOf('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const chosen = config.agents.filter((a) => !only.length || only.includes(a.key));

// pid 探活：ESRCH=进程不存在，EPERM=进程在但打不开句柄（也算活着）
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function prevEntries() {
  try {
    return JSON.parse(fs.readFileSync(PIDS_PATH, 'utf8')).pids || [];
  } catch {
    return [];
  }
}

// 机器重启后 pid 会被回收：pid 还在但群里该 Agent 明确不在线，就当它已经死了、允许重起。
// 服务不可达 / 令牌缺失时返回 null，退回纯 pid 探活，不因此卡住启动。
async function onlineAgentKeys() {
  let t;
  try {
    t = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch {
    return null;
  }
  const server = process.env.SERVER || t.server || config.server || 'http://127.0.0.1:8787';
  try {
    const res = await fetch(`${server}/api/groups/${t.groupId}`, {
      headers: { authorization: `Bearer ${t.ownerToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const keys = (data.members || []).filter((m) => m.online && m.agentKey).map((m) => m.agentKey);
    return new Set(keys);
  } catch {
    return null;
  }
}

const online = await onlineAgentKeys();
const liveByKey = new Map();
for (const e of prevEntries()) {
  if (!e?.key || !alive(e.pid)) continue;
  if (online && !online.has(e.key)) continue;
  liveByKey.set(e.key, e.pid);
}

const toStart = chosen.filter((a) => !liveByKey.has(a.key));
const skipped = chosen.filter((a) => liveByKey.has(a.key));
if (skipped.length) {
  console.log(`已在运行，跳过：${skipped.map((a) => `${a.key}(pid ${liveByKey.get(a.key)})`).join('、')}`);
}
// 沿用的存活条目：含 --only 没选中但仍在跑的 key，绝不写空表（写空等于把活口记录丢了，下轮必重复起）
const carried = [...liveByKey].map(([key, pid]) => ({ key, pid }));

function writePids(pids) {
  fs.mkdirSync(path.dirname(PIDS_PATH), { recursive: true });
  fs.writeFileSync(
    PIDS_PATH,
    JSON.stringify({ startedAt: new Date().toISOString(), pids }, null, 2),
  );
}

if (!toStart.length) {
  writePids(carried);
  console.log('桥接器都已在运行，本次不重复启动。');
  process.exit(0);
}

const children = [];
console.log(`准备启动 ${toStart.length} 个 Agent 桥接器：${toStart.map((a) => a.name).join('、')}`);
for (const a of toStart) {
  const child = spawn(process.execPath, ['--no-warnings', 'agents/bridge.mjs', `--key=${a.key}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${a.key}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${a.key}] ${d}`));
  child.on('exit', (code) => console.log(`[${a.key}] 退出，code=${code}`));
  children.push(child);
}

// 合并写回：沿用的存活条目 + 本次新起的，不丢活口
writePids([...carried, ...children.map((c, i) => ({ key: toStart[i].key, pid: c.pid }))]);

const shutdown = () => {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('桥接器全部启动，Ctrl+C 结束。');
