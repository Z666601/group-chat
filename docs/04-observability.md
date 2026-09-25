# 可观测性配置

三块内容：**结构化日志**、**指标接口**、**审计台账**。

---

## 1. 结构化日志

- 位置：`<LOG_DIR>/app.log`（默认 `data/logs/app.log`）
- 格式：JSON Lines，每行一条记录
- 同时输出到标准输出，便于被 systemd / journald / 容器日志收集

**字段**：

| 字段 | 说明 |
|---|---|
| `ts` | ISO-8601 时间戳 |
| `level` | `debug` / `info` / `warn` / `error` |
| `msg` | 事件名（点号分隔，如 `message.sent`、`server.listening`） |
| 其他 | 事件相关字段（`groupId`、`userId`、`messageId`、`seq`、`err` 等） |

**关键事件**：

| 事件 | 级别 | 含义 |
|---|---|---|
| `server.listening` | info | 服务启动，含监听地址与数据目录 |
| `db.ready` | info | 数据库就绪，含各表行数 |
| `message.sent` | info | 一条消息落库并扇出成功 |
| `message.insert_failed` | error | 消息写库失败 |
| `http.unhandled` | error | 未捕获异常（含堆栈） |
| `ws.error` | warn | 连接层异常 |
| `server.shutdown` | info | 优雅关闭 |
| `maintenance.tick` | info | 每 15 分钟的会话清理与行数快照 |

**检索示例**：

```bash
tail -f data/logs/app.log                                  # 实时跟踪
grep '"level":"error"' data/logs/app.log                   # 只看错误
grep '"msg":"message.sent"' data/logs/app.log | tail -20   # 最近发送
grep '"groupId":"grp_xxx"' data/logs/app.log               # 按群过滤
```

提高详细度：`LOG_LEVEL=debug`。关闭日志：`LOG_LEVEL=silent`（审计台账仍会记录）。

---

## 2. 指标接口

### `GET /healthz`（无需鉴权）

```json
{"ok":true,"status":"healthy","now":"2026-09-15T13:12:00.000Z","uptimeSec":128,"db":{"users":3,"messages":13,...}}
```

适合接入负载均衡健康检查与 uptime 监控。

### `GET /api/admin/metrics`（需 `x-admin-token`）

```json
{
  "ok": true,
  "metrics": {
    "counters": {
      "http.request": 1,
      "ws.open": 500,
      "ws.subscribe": 499,
      "ws.close": 0,
      "message.sent": 200,
      "message.persist.count": 200,
      "message.persist.sum_ms": 2103,
      "message.sent_rest": 0,
      "authz.denied.read_messages": 1,
      "abuse.rate_limited": 32,
      "upload.ok": 0
    },
    "latencyMs": { "count": 201, "p50": 10, "p95": 13, "p99": 14, "max": 15 }
  },
  "hub": { "rooms": 1, "connections": 499, "onlineUsers": 499 }
}
```

**计数器一览**：

| 计数器 | 含义 |
|---|---|
| `http.request` / `http.error` | HTTP 请求数与未捕获错误数 |
| `ws.open` / `ws.close` / `ws.subscribe` | 连接建立、断开、订阅数 |
| `message.sent` / `message.sent_rest` | 分别经实时通道 / REST 发送的消息数 |
| `message.persist.*` | 落库耗时（`count` / `sum_ms` → 可算均值） |
| `authz.denied.*` | 各类越权拦截数 |
| `abuse.rate_limited` / `abuse.text_too_long` / `abuse.bad_image_type` / `abuse.image_too_large` | 各类滥用拦截数 |
| `auth.login` / `auth.login_failed` / `auth.register` | 登录注册 |
| `group.create` / `group.join` / `group.member_remove` / `group.dissolve` | 群生命周期 |
| `upload.ok` | 图片上传成功数 |
| `session.expired` | 过期会话清理数 |

### `GET /api/admin/overview`（需 `x-admin-token`）

总览：各表行数 + 全部指标 + 进程内存/运行时长 + 审计分类计数 + 实时中枢状态。

```bash
curl -s http://127.0.0.1:8787/api/admin/overview -H "x-admin-token: $ADMIN_TOKEN" | python -m json.tool
```

**建议告警项**：

| 告警 | 条件 |
|---|---|
| 服务不可用 | `/healthz` 连续 3 次失败 |
| 错误激增 | `http.error` 5 分钟增量 > 10 |
| 滥用激增 | `abuse.rate_limited` 5 分钟增量 > 100 |
| 越权尝试 | `authz.denied.*` 任意非零即关注 |
| 连接掉线 | `hub.connections` 相对基线下降 > 50% |

---

## 3. 审计台账

表：`audit_log`（`id, ts, type, actor_id, group_id, target_id, detail, ip`），索引覆盖 `ts` / `group_id` / `actor_id` / `type`。

**事件类型**：

| 类型 | 触发 |
|---|---|
| `register` / `register_rejected` | 注册成功 / 被规则拒绝 |
| `login` / `login_failed` / `login_blocked` | 登录 |
| `logout` | 登出 |
| `group_create` / `group_update` / `group_dissolve` | 群生命周期 |
| `member_join` / `member_add` / `member_remove` / `member_leave` | 成员变更 |
| `authz_denied` | 越权拦截（`detail.op` 标明操作） |
| `admin_denied` | 管理令牌错误 |
| `rate_limited` | 限流拦截 |
| `invalid_input` | 非法输入（`detail.reason`） |
| `join_failed` | 邀请码无效 |

**查询**：

```bash
# 按群 + 时间段
curl -s "http://127.0.0.1:8787/api/admin/audit?groupId=grp_xxx&from=2026-09-01T00:00:00Z&to=2026-09-30T23:59:59Z" \
  -H "x-admin-token: $ADMIN_TOKEN"

# 按用户
curl -s "http://127.0.0.1:8787/api/admin/audit?actorId=usr_xxx" -H "x-admin-token: $ADMIN_TOKEN"

# 按类型
curl -s "http://127.0.0.1:8787/api/admin/audit?type=authz_denied" -H "x-admin-token: $ADMIN_TOKEN"

# 导出 CSV（含 BOM，Excel 可直接打开）
curl -s "http://127.0.0.1:8787/api/admin/audit/export?limit=5000" -H "x-admin-token: $ADMIN_TOKEN" -o audit.csv
```

**消息台账核对**（按群与时间段）：

```bash
curl -s "http://127.0.0.1:8787/api/admin/messages?groupId=grp_xxx&limit=200" -H "x-admin-token: $ADMIN_TOKEN"
```

**直接查库**：

```bash
sqlite3 data/chat.db "select type, count(*) from audit_log group by type order by 2 desc;"
sqlite3 data/chat.db "select ts,type,actor_id,detail from audit_log where type='authz_denied' order by id desc limit 20;"
```

---

## 4. 日志轮转

`app.log` 会持续增长。生产建议用 logrotate（Linux）：

```
# /etc/logrotate.d/group-chat
/opt/group-chat/data/logs/app.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
```

Windows 可用计划任务定期归档。
