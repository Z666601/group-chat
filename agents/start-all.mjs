// 一次性拉起所有 Agent 桥接器
// 用法：node agents/start-all.mjs [--only=hermes,ekko] [--once=开局语]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'agents.config.json'), 'utf8'));

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : args[args.indexOf(hit) + 1] ?? d;
};
const only = (argOf('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const chosen = config.agents.filter((a) => !only.length || only.includes(a.key));
const children = [];

console.log(`准备启动 ${chosen.length} 个 Agent 桥接器：${chosen.map((a) => a.name).join('、')}`);
for (const a of chosen) {
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

const shutdown = () => {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 记录 PID 便于停止脚本清理
fs.writeFileSync(
  path.join(ROOT, 'data', 'bridge-pids.json'),
  JSON.stringify({ startedAt: new Date().toISOString(), pids: children.map((c, i) => ({ key: chosen[i].key, pid: c.pid })) }, null, 2),
);
console.log('桥接器全部启动，Ctrl+C 结束。');
