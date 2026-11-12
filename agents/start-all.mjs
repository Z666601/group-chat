// 一次性拉起所有 Agent 桥接器（幂等：key 已在跑就跳过，可重复执行）
// 用法：node agents/start-all.mjs [--only=hermes,ekko] [--once=开局语]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// GC_* 环境变量是自检（tests/smoke.mjs）用的隔离缝隙：把配置/令牌/PID 表指到临时文件，
// 自检跑 start-all 就不会碰用户真实的 agents/.tokens.local.json 与 data/bridge-pids.json。
const CONFIG_PATH = process.env.GC_AGENTS_CONFIG || path.join(__dirname, 'agents.config.json');
const TOKENS_PATH = process.env.GC_TOKENS_FILE || path.join(__dirname, '.tokens.local.json');
const PIDS_PATH = process.env.GC_BRIDGE_PIDS || path.join(ROOT, 'data', 'bridge-pids.json');

// supervisor 起不来本身要变成调度台报警：看门狗死了群里必须有人喊一嗓子。
// 必须先于 config 读取注册；exit 是同步事件，异步 fetch 发不出去——
// 用 spawnSync 起一次性 node 代发（20s 超时兜底）。
let startupFatal = null;
process.on('exit', (code) => {
  if (!startupFatal || code === 0) return;
  try {
    const tokensFile = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    const text = `〔调度台〕（系统自动消息）start-all 看门狗启动失败：${String(startupFatal).slice(0, 120)}。桥接器无人守护，请检查并手动重启。`;
    spawnSync(process.execPath, ['-e', `
      fetch(process.argv[1] + '/api/groups/' + process.argv[2] + '/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.argv[3] },
        body: JSON.stringify({ text: process.argv[4] }),
      }).then((r) => console.log('alert', r.status)).catch((e) => console.log('alert-fail', e.message));
    `, tokensFile.server || 'http://127.0.0.1:8787', tokensFile.groupId, tokensFile.ownerToken, text], { timeout: 20000 });
  } catch { /* 报警通道也挂了：只剩本条 stderr */ }
});

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  // 配置坏是最典型的「supervisor 起不来」：报警后带码退出
  startupFatal = `配置文件解析失败（${CONFIG_PATH}）：${err?.message || err}`;
  process.exit(1);
}

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

// ── 单实例闸门（锁文件 + pid 探活 + cmdline 防呆）：双 supervisor 会把看门狗职责劈成两半，
// 重启一次多留一个孤儿。锁里 pid 活着且确实是 start-all → 本实例退出；
// pid 活但不是 start-all（pid 复用/异物占锁）→ 告警并接管；死锁（孤儿残留）→ 接管。
// 探针群用 GC_STARTALL_LOCK 指向临时文件，与生产闸门互不干扰。
const LOCK_PATH = process.env.GC_STARTALL_LOCK || path.join(ROOT, 'data', 'start-all.lock');

// 查进程 cmdline（只在锁 pid 存活的罕见路径调用）；查不到返回 '' 视为无法确认
function procCmdline(pid) {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 15000 });
    return String(r.stdout || '').trim();
  } catch {
    return '';
  }
}

try {
  const prev = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  if (prev?.pid && prev.pid !== process.pid && alive(prev.pid)) {
    const cmdline = procCmdline(prev.pid);
    if (cmdline && !/start-all\.mjs/.test(cmdline)) {
      // pid 被回收复用给了别的程序（或异物占锁）：不得误判为已有实例
      console.log(`警告：start-all 锁指向存活进程 ${prev.pid}，但其命令行不是本仓 start-all（${cmdline.slice(0, 80)}），判定为陈旧锁，本实例接管。`);
    } else {
      console.log(`已有 start-all 实例在运行（pid ${prev.pid}），本实例退出。`);
      process.exit(0);
    }
  }
} catch { /* 无锁或坏锁：本实例接管 */ }
fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

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

// ── 调度监视器（多脑闭环常驻钩子）：跟桥一起守护；GC_MONITOR_OFF=1 跳过（自检隔离）──
const MONITOR_KEY = '__monitor__';
const monitorOff = process.env.GC_MONITOR_OFF === '1';
// 监视器没有群内在线状态，只按 pid 探活，不做 online 校验
function liveMonitorPid() {
  for (const e of prevEntries()) {
    if (e?.key === MONITOR_KEY && alive(e.pid)) return e.pid;
  }
  return null;
}
const monitorPrevPid = monitorOff ? null : liveMonitorPid();
const monitorToStart = monitorOff ? false : monitorPrevPid == null;
if (monitorPrevPid != null) liveByKey.delete(MONITOR_KEY);

const toStart = chosen.filter((a) => !liveByKey.has(a.key));
const skipped = chosen.filter((a) => liveByKey.has(a.key));
if (skipped.length) {
  console.log(`已在运行，跳过：${skipped.map((a) => `${a.key}(pid ${liveByKey.get(a.key)})`).join('、')}`);
}
if (monitorPrevPid != null) console.log(`调度监视器已在运行（pid ${monitorPrevPid}），跳过`);
// 沿用的存活条目：含 --only 没选中但仍在跑的 key，绝不写空表（写空等于把活口记录丢了，下轮必重复起）
const carried = [...liveByKey].map(([key, pid]) => ({ key, pid }));
if (monitorPrevPid != null) carried.push({ key: MONITOR_KEY, pid: monitorPrevPid });

function writePids(pids) {
  fs.mkdirSync(path.dirname(PIDS_PATH), { recursive: true });
  fs.writeFileSync(
    PIDS_PATH,
    JSON.stringify({ startedAt: new Date().toISOString(), pids }, null, 2),
  );
}

if (!toStart.length && !monitorToStart) {
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
    detached: true, // Windows 上不 detached 的子进程随父连坐（job object）——桥必须活得比 supervisor 久
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${a.key}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${a.key}] ${d}`));
  child.on('exit', (code) => console.log(`[${a.key}] 退出，code=${code}`));
  children.push(child);
}

if (monitorToStart) {
  console.log('启动调度监视器（监听钩子，零模型消耗）');
  const monitorChild = spawn(process.execPath, ['--no-warnings', 'agents/discussion-monitor.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true, // 同桥：不随 supervisor 连坐
  });
  monitorChild.stdout.on('data', (d) => process.stdout.write(`[monitor] ${d}`));
  monitorChild.stderr.on('data', (d) => process.stderr.write(`[monitor] ${d}`));
  children.push(monitorChild);
}

// 合并写回：沿用的存活条目 + 本次新起的，不丢活口
// 监视器条目排在桥接器之后，key 取 MONITOR_KEY
writePids([
  ...carried,
  ...children.map((c, i) => ({ key: toStart[i]?.key ?? MONITOR_KEY, pid: c.pid })),
]);

const shutdown = () => {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── 周期自愈：巡检 pid 表，死掉的桥/监控按原 key 补起（detached）。
// 单实例闸门挡掉了「重跑 start-all 补活」的旧路径，看门狗必须自己扛自愈；
// 没有 online 校验——桥有 3 秒 WS 重连，pid 活着即视为在岗。
const HEAL_MS = Number(process.env.GC_HEAL_MS || 60000);
let healing = false;
setInterval(() => {
  if (healing) return;
  healing = true;
  try {
    const entries = prevEntries();
    let changed = false;
    const next = [];
    for (const e of entries) {
      if (!e?.key || !Number.isInteger(e.pid)) { next.push(e); continue; }
      if (alive(e.pid)) { next.push(e); continue; }
      if (e.key === MONITOR_KEY) {
        const c = spawn(process.execPath, ['--no-warnings', 'agents/discussion-monitor.mjs'], {
          cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true,
        });
        c.stdout.on('data', (d) => process.stdout.write(`[monitor] ${d}`));
        c.stderr.on('data', (d) => process.stderr.write(`[monitor] ${d}`));
        c.on('exit', (code) => console.log(`[monitor] 退出，code=${code}`));
        children.push(c);
        next.push({ key: MONITOR_KEY, pid: c.pid });
        changed = true;
        console.log(`自愈：调度监视器已补起（pid ${c.pid}）`);
      } else if (config.agents.some((a) => a.key === e.key)) {
        const c = spawn(process.execPath, ['--no-warnings', 'agents/bridge.mjs', `--key=${e.key}`], {
          cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true,
        });
        c.stdout.on('data', (d) => process.stdout.write(`[${e.key}] ${d}`));
        c.stderr.on('data', (d) => process.stderr.write(`[${e.key}] ${d}`));
        c.on('exit', (code) => console.log(`[${e.key}] 退出，code=${code}`));
        children.push(c);
        next.push({ key: e.key, pid: c.pid });
        changed = true;
        console.log(`自愈：桥接器 ${e.key} 已补起（pid ${c.pid}）`);
      } else {
        next.push(e); // 非本配置管理的条目，原样保留
      }
    }
    if (changed) writePids(next);
  } catch (err) {
    console.log('自愈巡检失败：', String(err?.message || err).slice(0, 120));
  } finally {
    healing = false;
  }
}, HEAL_MS);

console.log('桥接器全部启动，Ctrl+C 结束。');
