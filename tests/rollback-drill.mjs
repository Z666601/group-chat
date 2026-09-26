// 回滚演练：验证「备份 → 恢复」链路真实可用
// 用法：node --no-warnings tests/rollback-drill.mjs
// 说明：不破坏现有数据库。做法是：在线备份 → 校验备份 → 从备份恢复到全新文件 → 比对数据一致性。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 与 server/index.mjs 的默认口径保持一致：以前默认写死 data/live，导致 npm run drill
// 悄悄演练了一份 9/15 的历史残库（4KB），线上库从没被真正备份校验过。
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const LIVE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(DATA_DIR, 'chat.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = path.join(BACKUP_DIR, `chat-${STAMP}.db`);
const RESTORED = path.join(DATA_DIR, `restore-drill-${STAMP}.db`);

const T = (db) => ({
  users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  groups: db.prepare('SELECT COUNT(*) c FROM groups').get().c,
  messages: db.prepare('SELECT COUNT(*) c FROM messages WHERE deleted_at IS NULL').get().c,
  audit: db.prepare('SELECT COUNT(*) c FROM audit_log').get().c,
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
};

if (!fs.existsSync(LIVE)) {
  console.error('未找到数据库：' + LIVE + '\n请先启动一次服务（node server/index.mjs）或指定 DATA_DIR。');
  process.exit(1);
}
fs.mkdirSync(BACKUP_DIR, { recursive: true });

console.log('\n── 回滚演练 ──────────────────────────────────');
console.log('源数据库 :', LIVE);

// 1) 在线备份（服务可同时在跑）
const src = new DatabaseSync(LIVE, { readOnly: true });
const before = T(src);
const t0 = Date.now();
await backup(src, BACKUP);
src.close();
const backupMs = Date.now() - t0;
console.log('备份文件 :', BACKUP, `(${(fs.statSync(BACKUP).size / 1024).toFixed(1)} KB, ${backupMs}ms)`);
check('在线备份完成且文件非空', fs.statSync(BACKUP).size > 0, `${backupMs}ms`);

// 2) 校验备份完整性
const bk = new DatabaseSync(BACKUP, { readOnly: true });
const integrity = bk.prepare('PRAGMA integrity_check').get();
const integrityValue = integrity ? Object.values(integrity)[0] : 'unknown';
check('备份完整性校验通过', integrityValue === 'ok', String(integrityValue));
const inBackup = T(bk);
bk.close();
check(
  '备份内容与源库一致',
  JSON.stringify(inBackup) === JSON.stringify(before),
  `src=${JSON.stringify(before)} backup=${JSON.stringify(inBackup)}`,
);

// 3) 从备份恢复到全新文件（模拟灾难恢复）
const rd = new DatabaseSync(BACKUP, { readOnly: true });
await backup(rd, RESTORED);
rd.close();
const rs = new DatabaseSync(RESTORED, { readOnly: true });
const restoredIntegrity = Object.values(rs.prepare('PRAGMA integrity_check').get())[0];
const after = T(rs);
rs.close();
check('恢复文件完整性校验通过', restoredIntegrity === 'ok', String(restoredIntegrity));
check('恢复后数据与备份一致', JSON.stringify(after) === JSON.stringify(inBackup), JSON.stringify(after));

// 4) 抽样核对具体记录（防止「计数相同但内容不同」）
const a = new DatabaseSync(LIVE, { readOnly: true });
const b = new DatabaseSync(RESTORED, { readOnly: true });
const sampleA = a.prepare('SELECT id, group_id, seq, sender_id, body FROM messages ORDER BY seq LIMIT 5').all();
const sampleB = b.prepare('SELECT id, group_id, seq, sender_id, body FROM messages ORDER BY seq LIMIT 5').all();
check('抽样记录逐字段一致', JSON.stringify(sampleA) === JSON.stringify(sampleB), `${sampleA.length} 条`);
const auditA = a.prepare('SELECT type, COUNT(*) c FROM audit_log GROUP BY type ORDER BY type').all();
const auditB = b.prepare('SELECT type, COUNT(*) c FROM audit_log GROUP BY type ORDER BY type').all();
check('审计台账分类计数一致', JSON.stringify(auditA) === JSON.stringify(auditB), JSON.stringify(auditA));
a.close();
b.close();

console.log('\n演练结果:', `${results.filter((r) => r.ok).length}/${results.length} 通过`);
console.log('备份文件     :', BACKUP);
console.log('恢复验证文件 :', RESTORED);
console.log('说明：演练未触碰线上数据；恢复文件用于验证，可安全删除。');

fs.writeFileSync(
  path.join(BACKUP_DIR, 'rollback-drill-report.json'),
  JSON.stringify({ at: new Date().toISOString(), live: LIVE, backup: BACKUP, restored: RESTORED, backupMs, counts: before, results }, null, 2),
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
