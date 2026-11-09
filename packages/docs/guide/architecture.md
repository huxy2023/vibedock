# 核心架构与安全边界

## 1. Monorepo 包结构

VibeDock 采用 `pnpm` Workspace Monorepo 架构，职责边界清晰：

```text
vibedock/
├── pnpm-workspace.yaml
├── package.json
└── packages/
    ├── vibedock/          # 核心 npm 包：Hono + TS 服务端、vibedock CLI、零依赖 Skill 客户端与部署引擎
    ├── web/               # 门户前端：React 19 + Vite + TypeScript（构建产物输出至 packages/vibedock/public）
    └── docs/              # 官方文档站：VitePress
```

---

## 2. 服务端统一状态目录 (`/var/lib/vibedock`)

为了保证代码（`/usr/lib/node_modules/vibedock`）与运行时数据彻底分离，Linux 生产环境将所有配置、证书、SQLite 数据库与团队应用全部收口在 `/var/lib/vibedock`（可通过环境变量 `VIBEDOCK_HOME` 定制），随时执行 `npm i -g vibedock` 升级版本绝不覆盖线上状态：

```text
/var/lib/vibedock/
├── vibedock.config.json       # 主配置文件 (0600)
├── catalog.json               # 应用目录与路由表
├── vibedock-auth.sqlite3      # 账号、会话与邀请码库 (0600, 含 -wal / -shm)
├── vibedock-chat.sqlite3      # AI 诊断会话与运维审批审计库 (0600, 含 -wal / -shm)
├── vibedock-deploy.zip        # 已烘焙好的团队专属 AI 部署 Skill 包 (0600)
├── keys/                      # SSH 免密部署密钥对 (0700)
├── certs/                     # 泛域名/自定义 TLS 证书 (0644) 与私钥 (0640 root:caddy, 目录 0750)
├── acme/                      # acme.sh 客户端、CA 账户与自动续期配置 (0700)
├── caddy/sites/               # Caddy 动态导入的门户与应用路由配置 (*.caddy)
├── nginx/sites/               # Nginx Drop-in / Chain 路由配置 (*.conf)
├── secrets/databases/         # 数据库管理员与各项目隔离凭据 (0700)
├── databases/                 # 共享数据库持久化卷与 .env.db (0600)
├── backups/databases/         # 按时间戳归档的项目数据库备份与 manifest.json (0700)
├── pm2/                       # vibedock-portal 专属隔离 PM2_HOME (0700)
├── apps/                      # 团队已发布的全部应用代码与软链 (/var/lib/vibedock/apps/<id>)
└── deploy/                    # 受限部署账号 vibe-deploy 家目录 (.ssh 与 .pm2)
```

---

## 3. 服务端分层设计 (`packages/vibedock/src`)

- **`http/`**：Hono 路由层与鉴权中间件（`auth.ts`, `catalog.ts`, `assistant.ts`, `operations.ts`），支持流式 SSE（`streamSSE`）。
- **`services/`**：
  - `auth.ts`：基于 Node 内置 `node:sqlite` 的会话、密码哈希与邀请码服务（强制 WAL 与 `0600` 权限）。
  - `catalog.ts`：内存目录索引与原子落盘写入，支持跨进程 `mtimeMs` 变化自动热刷新，并在生成快照时同步采集宿主机真实水位（`collectHostSystemSummary`）与各项目本地监听端口的进程资源占用（`collectProcessMetrics`）。
  - `actions.ts`：高危运维动作（重启 PM2 进程、热重载 Caddy）的审批状态机与审计日志。
  - `assistant/`：多协议 AI Agent（OpenAI / Anthropic / Gemini / DeepSeek），内置沙盒文件只读工具与零配置本地兜底诊断。
- **`deploy/`**：
  - `caddy.ts`：每个应用独立的 Caddy 站点片段生成器（`/var/lib/vibedock/caddy/sites/team-<id>.caddy`）。
  - `databases.ts`：4 大共享数据库的幂等建库、建用户与凭据持久化。
  - `publish.ts`：端口池分配（`40000-40999`）、组件契约校验、`caddy validate` 预检与失败自动回滚。

---

## 4. 安全防线设计

1. **受限部署账号与 `sudoers` 白名单**：开发者 Skill 通过 SSH 登录受限账号 `vibe-deploy`（家目录 `/var/lib/vibedock/deploy`），仅被授权通过 `/usr/local/bin/vibedock-publish` 与 `/usr/local/bin/vibedock-db-provision` 执行受控发布与建库，无法读取 `/var/lib/vibedock` 下的 SQLite 主库、TLS 私钥或全局数据库管理员密码。
2. **网关语法预检与事务回滚**：每次发布（`vibedock publish`）或更新证书（`vibedock tls`）都会先执行 `caddy validate` 语法与证书校验，若校验或重载失败自动回滚配置文件、目录快照与路由片段。
3. **Skill 压缩包鉴权保护**：`vibedock-deploy.zip` 内含服务器免密部署私钥，存储在 `/var/lib/vibedock/vibedock-deploy.zip`（`0600`），仅允许已登录成员或携带有效团队邀请码（`?code=<inviteCode>`）下载。
