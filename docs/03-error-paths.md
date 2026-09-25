# 异常路径处理

本文档说明各类异常场景下的**服务端行为、客户端行为、以及在后台如何查到**。

---

## 1. 断线重连

**触发场景**：网络中断、切换 Wi-Fi/蜂窝、笔记本休眠唤醒、服务端重启、Nginx 掐断长连接。

**服务端**：每 30 秒发送 `ping`，连续两个周期无 `pong` 则断开该连接（`heartbeat timeout`）。

**客户端**：
1. `close` 事件触发 → 顶部状态切为「已断开」
2. 指数退避重连：1s → 2s → 4s → 8s → 15s（上限 15s）
3. 页面 `online` 事件也会立即触发一次重连
4. 重连成功后，用本地最大 `seq` 发送 `subscribe{sinceSeq}`

**补齐语义**：服务端把 `seq > sinceSeq` 的消息按序补发，随后返回 `subscribed`。单次最多补齐 500 条，超出会带 `truncated: true`，客户端提示「离线期间消息较多，仅补齐最近 500 条」。

**不重不丢的保证**：
- 每条消息在**群内**有唯一 `seq`（`UNIQUE(group_id, seq)` 索引）
- 客户端按 `seq` 去重：`seqIndex` 命中则丢弃
- 实时推送与断线补齐可能重叠，去重在客户端完成

**排查**：日志搜 `ws.close`；指标看 `ws.open` / `ws.close` 计数差。

---

## 2. 消息重复

**来源**：客户端重复点击、超时重试、断线补齐与实时推送重叠。

**服务端**：`messages` 表对 `(group_id, sender_id, client_msg_id)` 建**唯一索引**。收到重复 `clientMsgId` 时直接回放既有消息并附 `duplicate: true`，不新增记录。

**客户端**：每条消息发送前生成随机 `clientMsgId`；「重试」复用同一个 `clientMsgId`，因此重试是安全的。

**验证**：

```bash
curl -s -X POST http://127.0.0.1:8787/api/groups/<群ID>/messages \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"重复提交测试","clientMsgId":"fixed-id-1"}'
# 再执行一次，两次返回同一 message.id 且第二次 duplicate=true
```

---

## 3. 发送失败

| 情形 | 表现 | 处理 |
|---|---|---|
| 实时通道未就绪 | 自动降级为 REST `POST /messages` | 对用户无感 |
| 8 秒无 `ack` | 标记「发送失败」+ 「重试」按钮 | 点击重试复用同一 `clientMsgId` |
| 服务端落库异常 | 返回 `send_failed` 事件 | 同上；服务端记录 `message.insert_failed` 日志 |
| 服务端拒绝（如非成员） | 返回 `error` 事件并置为失败 | 提示原因 |

---

## 4. 越权访问

服务端**逐请求**判定，前端隐藏入口不作为安全边界。

| 请求 | 响应 | 台账类型 |
|---|---|---|
| 未登录访问受保护接口 | `401 unauthenticated` | — |
| 非成员读取群消息 | `403 not_a_member` | `authz_denied` |
| 非成员订阅实时通道 | `error: not_a_member` | `authz_denied` |
| 非成员发送消息 | `403 not_a_member` | `authz_denied` |
| 普通成员解散群 / 移除他人 | `403 forbidden` | `authz_denied` |
| 非成员访问群附件 | `403 not_a_member` | `authz_denied` |
| 管理接口令牌错误 | `403 admin_forbidden` | `admin_denied` |

**查询**：

```bash
curl -s "http://127.0.0.1:8787/api/admin/audit?type=authz_denied&limit=50" -H "x-admin-token: $ADMIN_TOKEN"
```

台账 `detail` 字段记录具体操作（如 `op: "read_messages"`），`group_id`、`actor_id`、`ip` 均可作为筛选维度。

---

## 5. 限流

**算法**：按用户维度的令牌桶。默认容量 12（可突发 12 条），补充速率 2 条/秒（稳态约 120 条/分钟）。

**超出时**：返回

```json
{ "type": "error", "code": "rate_limited", "message": "发送过于频繁，请稍后再试", "retryAfterMs": 480 }
```

同时写入 `audit_log`（`type=rate_limited`，`detail.retryAfterMs`）。

**调整**：修改 `server/hub.mjs` 中 `DEFAULT_LIMITS.msgRateCapacity` / `msgRateRefillPerSec`。

---

## 6. 输入校验

| 输入 | 规则 | 违反时 |
|---|---|---|
| 用户名 | 3–24 位字母/数字/下划线 | `400 invalid_input` |
| 密码 | 8–128 位 | `400 invalid_input` |
| 昵称 | 1–32 位 | `400 invalid_input` |
| 群名称 | 1–40 位 | `400 invalid_input` |
| 消息文本 | 非空且 ≤ `MAX_TEXT_LENGTH`（默认 2000） | `empty_message` / `text_too_long` |
| 图片 MIME | `image/png` `image/jpeg` `image/webp` `image/gif` | `415 unsupported_media_type` |
| 图片大小 | ≤ `MAX_IMAGE_MB`（默认 5MB） | `413 payload_too_large` |
| WebSocket 帧 | 客户端帧必须掩码，单帧 ≤ 8MB | 以 `1002` / `1009` 关闭连接 |
| 单条 HTTP 请求体 | ≤ 256KB（上传接口单独走图片上限） | `400 payload_too_large` |

`text_too_long` / `bad_image_type` / `image_too_large` 会写入 `invalid_input` 台账。

---

## 7. 封禁与账号停用

`users.status` 支持 `active` / `banned`。置为 `banned` 后：

- 登录被拒：`403 account_disabled`，写入 `login_blocked` 台账
- 已签发会话在下次请求时失效：`resolveUser()` 校验 `status !== 'active'` 即拒绝

**操作**：

```bash
sqlite3 data/chat.db "update users set status='banned' where username='spammer';"
```

> 建议后续把该操作封装成 `POST /api/admin/users/:id/ban` 并在台账留痕。

---

## 8. 群解散后的访问

`groups.status = 'dissolved'` 后：

- 读取消息：`410 group_dissolved`（明确告知已解散，而非 404）
- 读取群详情：`410`
- 读取群附件：附件访问需要成员校验，成员身份仍在但群已解散 → 由消息接口的 410 兜底
- 群不再出现在任何成员的 `GET /groups` 列表中
- 实时通道广播 `group-dissolved`，在线客户端立即关闭该会话

**数据策略**：解散**不物理删除**消息，便于审计与取证；如需彻底清除，按数据保留策略单独执行（见回滚文档第 3 节的清理命令）。

---

## 9. 服务端异常

- 未捕获异常：统一返回 `500 internal_error`，并写 `http.unhandled` 错误日志（含堆栈）
- 数据库写冲突：捕获后尝试回放既有消息，失败则返回 `send_failed`
- 进程退出：`SIGINT` / `SIGTERM` 触发优雅关闭，关闭 HTTP 监听并关闭数据库

**排查**：

```bash
grep '"level":"error"' data/logs/app.log | tail -50
```
