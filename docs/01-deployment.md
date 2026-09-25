# 部署说明

## 1. 服务器要求

| 项 | 最低 | 建议 |
|---|---|---|
| 操作系统 | Linux x64 / Windows Server 2019+ / macOS | Ubuntu 22.04 LTS |
| Node.js | **22.5+**（内置 `node:sqlite` 需要） | 22.22 LTS |
| CPU | 1 vCPU | 2 vCPU |
| 内存 | 512 MB | 1 GB |
| 磁盘 | 1 GB | 10 GB（含图片与日志） |
| 网络 | 单个监听端口（默认 8787） | 前置 Nginx/Caddy 终止 TLS |

> 本项目**无 npm 依赖**，不需要 `npm install`，也没有构建步骤。前端是原生 HTML/JS/CSS，由同一个进程直接托管。

## 2. 环境变量清单

复制 `.env.example` 为 `.env` 后按需修改：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。前置反代时保持回环地址；直接对外则设 `0.0.0.0` |
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `./data` | 数据根目录（数据库、上传、日志） |
| `DB_FILE` | `<DATA_DIR>/chat.db` | 数据库文件路径 |
| `LOG_DIR` | `<DATA_DIR>/logs` | 日志目录（JSON Lines） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `MAX_TEXT_LENGTH` | `2000` | 单条文本上限（字符） |
| `MAX_IMAGE_MB` | `5` | 单张图片上限（MB） |
| `MAX_GROUP_MEMBERS` | `200` | 单群成员上限 |
| `ADMIN_TOKEN` | 空 | 管理接口令牌。**留空则 `/api/admin/*` 整体关闭**；生产必须设置为足够长的随机串 |

生成管理令牌：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. 启动步骤

```bash
# 1) 准备代码与配置
cd /opt/group-chat
cp .env.example .env
vi .env                              # 至少设置 ADMIN_TOKEN、HOST

# 2) 初始化数据库（幂等，可重复执行）
node --no-warnings scripts/migrate.mjs

# 3) 前台试跑，确认无报错
node --no-warnings server/index.mjs

# 4) 健康检查
curl -s http://127.0.0.1:8787/healthz
```

期望返回：

```json
{"ok":true,"status":"healthy","now":"...","uptimeSec":1,"db":{"users":0,"sessions":0,...}}
```

## 4. 常驻运行

### Linux（systemd）

`/etc/systemd/system/group-chat.service`：

```ini
[Unit]
Description=Auto Group Chat
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/group-chat
EnvironmentFile=/opt/group-chat/.env
ExecStart=/usr/bin/node --no-warnings /opt/group-chat/server/index.mjs
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now group-chat
sudo systemctl status group-chat
```

### Windows（计划任务或 NSSM）

```powershell
# 以 NSSM 为例
nssm install GroupChat "C:\Program Files\nodejs\node.exe" "--no-warnings C:\apps\group-chat\server\index.mjs"
nssm set GroupChat AppDirectory C:\apps\group-chat
nssm set GroupChat AppEnvironmentExtra PORT=8787 HOST=127.0.0.1
nssm start GroupChat
```

## 5. 域名与 TLS

用 Nginx 终止 TLS 并把 WebSocket 一起反代（`Upgrade` 头必须透传，否则实时通道会退化为轮询失败）：

```nginx
server {
  listen 443 ssl http2;
  server_name chat.example.com;

  ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

  client_max_body_size 8m;              # 要大于 MAX_IMAGE_MB

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # ← WebSocket 必需
    proxy_set_header Connection "upgrade";       # ← WebSocket 必需
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;                    # 长连接不被中途掐断
  }
}
```

HTTP 跳 HTTPS：

```nginx
server {
  listen 80;
  server_name chat.example.com;
  return 301 https://$host$request_uri;
}
```

证书签发：

```bash
sudo certbot --nginx -d chat.example.com
sudo certbot renew --dry-run
```

> 前端会自动按当前页面协议选择 `ws:` / `wss:`，无需额外配置。

## 6. 升级步骤

```bash
cd /opt/group-chat
systemctl stop group-chat            # 或先做滚动：见回滚文档的双目录切换
git pull                             # 或解压新版本覆盖
node --no-warnings scripts/migrate.mjs   # 结构变更为幂等增量
systemctl start group-chat
curl -s http://127.0.0.1:8787/healthz
```

升级前请先备份数据库（见回滚文档第 3 节）。若新版本引入了不兼容的表结构变更，回滚步骤见 `05-rollback.md`。

## 7. 数据与备份

| 内容 | 位置 |
|---|---|
| 数据库 | `<DATA_DIR>/chat.db`（另有 `-wal`、`-shm` 伴生文件） |
| 上传图片 | `<DATA_DIR>/uploads/` |
| 日志 | `<DATA_DIR>/logs/app.log` |

备份：

```bash
# 推荐：用 SQLite 在线备份，避免拷到写了一半的 WAL
sqlite3 data/chat.db ".backup 'backup/chat-$(date +%F-%H%M).db'"
tar czf backup/uploads-$(date +%F).tar.gz -C data uploads
```

## 8. 上线前检查清单

- [ ] `ADMIN_TOKEN` 已设置为随机长串，且未提交进版本库
- [ ] `HOST` 在生产环境未直接暴露到公网（由反代转发）
- [ ] Nginx 透传了 `Upgrade` / `Connection` 头
- [ ] `client_max_body_size` ≥ `MAX_IMAGE_MB`
- [ ] 已配置数据库定时备份
- [ ] `/healthz` 已接入监控
- [ ] 已验证 `node --version` ≥ 22.5
