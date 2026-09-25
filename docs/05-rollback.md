# 回滚方案

目标：出现严重问题时，**30 分钟内**退回上一可用版本，且数据不损坏。

---

## 1. 版本发布约定（回滚的前提）

推荐**双目录 + 软链**发布，让回滚等于换一个软链：

```
/opt/group-chat/
├─ releases/
│  ├─ 20260915-1/      ← 上一版本（保留）
│  └─ 20260915-2/      ← 当前版本
├─ current -> releases/20260915-2      ← 软链指向运行版本
└─ shared/
   ├─ .env
   └─ data/            ← 数据库、上传、日志（与版本解耦）
```

- 代码目录带时间戳，**每次发布新目录**，不原地覆盖
- `data/` 与 `.env` 放在 `shared/`，服务通过 `DATA_DIR=/opt/group-chat/shared/data` 指向它
- 发布前记录当前软链指向，作为回滚点

```bash
ln -sfn /opt/group-chat/releases/20260915-2 /opt/group-chat/current
systemctl restart group-chat
```

---

## 2. 版本回退步骤（目标 5 分钟内）

```bash
# 0) 记录现场
date; readlink -f /opt/group-chat/current; curl -s localhost:8787/healthz

# 1) 停服
sudo systemctl stop group-chat

# 2) 备份当前数据库（回滚也可能需要回退数据）
sqlite3 /opt/group-chat/shared/data/chat.db \
  ".backup '/opt/group-chat/shared/backup/chat-before-rollback-$(date +%F-%H%M).db'"

# 3) 切回上一版本
ln -sfn /opt/group-chat/releases/20260915-1 /opt/group-chat/current

# 4) 用旧版本代码检查结构（幂等，不会破坏数据）
cd /opt/group-chat/current
node --no-warnings scripts/migrate.mjs

# 5) 启动并验证
sudo systemctl start group-chat
sleep 2
curl -s localhost:8787/healthz
```

**验证清单**：`/healthz` 返回 `ok:true`；登录、建群、发一条消息、刷新后消息仍在。

### 如果不是双目录发布

```bash
git log --oneline -5                 # 找到上一可用 commit
git checkout <上一版本 commit>        # 或 git revert <问题 commit>
sudo systemctl restart group-chat
```

---

## 3. 数据库回滚策略

本项目采用**只增不改的幂等 DDL**：`db/schema.sql` 里全部是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。因此**升级不会破坏旧版本可读性**——旧代码面对多出来的列或索引仍能正常工作（SQLite 允许）。

由此得到两条策略：

### 策略 A（推荐）：结构新增兼容，不单独回滚数据库

代码回退后，直接让旧代码继续用同一个数据库。多数情况下旧版本只是「看不到」新字段，不影响读写。

**前提**：新版本只做了「加表 / 加列 / 加索引」。若新版本做过**删列、改列类型、改主键**，必须走策略 B。

### 策略 B：使用发布前备份恢复

```bash
sudo systemctl stop group-chat

# 保留当前数据以备取证
sqlite3 shared/data/chat.db ".backup 'shared/backup/chat-$(date +%F-%H%M).db'"

# 用发布前备份覆盖
rm -f shared/data/chat.db shared/data/chat.db-wal shared/data/chat.db-shm
sqlite3 shared/backup/chat-发布前.db ".backup 'shared/data/chat.db'"

# 校验
sqlite3 shared/data/chat.db "pragma integrity_check;"
sqlite3 shared/data/chat.db "select count(*) from messages;"

sudo systemctl start group-chat
curl -s localhost:8787/healthz
```

> ⚠️ 策略 B 会丢失备份点之后的新消息。执行前必须确认业务方可接受，或先把新消息导出留档。

### 结构变更的对应回退脚本

若某次发布新增了表/列，建议在 `shared/rollback/` 下留一份对应 SQL：

```sql
-- 示例：回退 20260915-2 引入的 pinned 表
DROP INDEX IF EXISTS idx_pinned_group;
DROP TABLE IF EXISTS pinned_messages;
```

> SQLite 3.35+ 支持 `ALTER TABLE ... DROP COLUMN`，但**删除列不可逆**，删前务必先做整库备份。

---

## 4. 备份与恢复

### 备份

```bash
# 每日在线备份（不会阻塞写入）
sqlite3 shared/data/chat.db ".backup 'shared/backup/chat-$(date +%F).db'"
tar czf shared/backup/uploads-$(date +%F).tar.gz -C shared/data uploads
find shared/backup -name 'chat-*.db' -mtime +30 -delete     # 保留 30 天
```

### 恢复

```bash
sudo systemctl stop group-chat
rm -f shared/data/chat.db shared/data/chat.db-wal shared/data/chat.db-shm
sqlite3 shared/backup/chat-2026-09-15.db ".backup 'shared/data/chat.db'"
sqlite3 shared/data/chat.db "pragma integrity_check;"
sudo systemctl start group-chat
```

推荐加一条 crontab：

```
15 3 * * * sqlite3 /opt/group-chat/shared/data/chat.db ".backup '/opt/group-chat/shared/backup/chat-$(date +\%F).db'"
```

### 定期演练（每季度一次）

1. 取一份生产备份，恢复到临时目录
2. 用 `DB_FILE=... node server/index.mjs` 在另一个端口起来
3. 走一遍「登录 → 查历史 → 发消息」
4. 记录实际耗时，确认在 30 分钟预算内

---

## 5. 回滚决策速查

| 现象 | 处置 |
|---|---|
| 新版本启动即崩 | 立即执行第 2 节（5 分钟） |
| 新版本功能缺陷但服务可用 | 评估影响面；必要时回滚 |
| 新版本写入的数据结构旧版本读不了 | 走策略 B（含数据回退），并通知业务方数据时间点 |
| 数据库损坏 | `pragma integrity_check` 判定 → 用最近备份恢复 |
| 只有单条数据异常 | 优先用审计台账定位与定点修复，避免整库回滚 |

---

## 6. 回滚后在台账中留痕

建议把每次回滚记录进审计台账或运维日志，便于事后复盘：

```bash
sqlite3 shared/data/chat.db \
  "insert into audit_log (ts,type,detail,ip) values (datetime('now'),'ops_rollback','{\"from\":\"20260915-2\",\"to\":\"20260915-1\"}','ops');"
```
