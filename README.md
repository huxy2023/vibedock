# VibeDock (`vibedock`)

> **Self-Hosted AI-Native Team App & Database Cloud**
> 专为 Vibe Coding 团队打造的自建演示门户与一键部署云：装一次 AI Skill，对 Claude Code / Codex / Cursor 说句话，即可把本地前端、后端服务（Node.js / Python `uv` / Go）与专属数据库推上团队服务器并自动分配独立子域名与 HTTPS 证书。

---

## ✨ 核心特性

1. **一句话 AI 部署（Zero-Friction AI Deploy Skill）**
   - 门户内置一键生成并下载团队专属的 `vibedock-deploy.zip` Skill 安装包（自动烘焙服务器 IP、主域名后缀、SSH 免密部署私钥与统一零依赖 Node ESM 客户端 `scripts/client.mjs`）。
   - 团队成员装好 Skill 后，无需记忆服务器 IP、SSH 密钥或 Caddy 语法，直接对 AI 编程助手说句话即可完成端口分配、构建产物上传、PM2 守护与独立子域名路由。
2. **公网与内网泛域名 HTTPS 证书全自动托管（`vibedock tls`）**
   - 公网服务器直接启用 Caddy Auto-HTTPS；内网 IP 服务器支持通过 `vibedock tls --dns <dnspod|aliyun|cf>` 一键调用 `acme.sh` (DNS-01) 签发 `*.<domain>` 泛域名通配符证书并自动注册 `cron` 续期任务，之后团队成员部署任何新应用均自动挂载 HTTPS 证书。
3. **4 大数据库三档灵活接入与新旧并存（自动避让端口 / 存量实例纳管 / 项目连接串直绑）**
   - **新旧并存自动避让 (`--db-strategy dedicated`)**：`vibedock init` 与 `vibedock db up` 自动探测本机端口；若默认端口（`5432/3306/27017/6379`）已被存量数据库占用，可一键将 VibeDock 专用容器平滑切换至并存端口（`45432/43306/47017/46379`），新旧数据库同机并存、互不干扰。
   - **存量数据库纳管 (`--db-strategy reuse` / `db register`)**：若选择复用本机或远程/RDS 数据库，可通过 `vibedock db register <engine> --url ...` 纳管，后续 `db provision <project>` 直接在该实例上自动按项目建库、分权与配置 Redis ACL 前缀。
   - **项目级连接串直绑 (`db bind`)**：无需管理员 root 密码，直接通过 `vibedock db bind <project> --postgresql <url>` 绑定现成连接串并统一导出 `db.env`。
4. **网关新旧共存与用户自主选择（`--gateway-strategy reuse | dedicated-chain | dedicated-port | none`）**
   - **绝不替用户做决定**：当检测到本机 80 端口已有 Nginx/Caddy 运行时，`vibedock init` 主动呈现基础设施探测报告并交由用户选择：
     - **`reuse`（复用现有网关）**：通过 `/var/lib/vibedock/nginx/sites/*.conf` 或 Caddy `import` 非侵入挂载子域名。
     - **`dedicated-chain`（双层串联专用网关）**：新建独立 `vibedock-caddy` 守护进程仅绑定 `127.0.0.1:39080` 并生成一次性外层泛域名转发片段（`/var/lib/vibedock/gateway-upstream-snippet.conf`），后续发布/下线应用只热重载内部专用网关，原 Nginx/Caddy 永久零改动、零重载。
     - **`dedicated-port`（独立端口专用网关）**：新建独立 `vibedock-caddy` 监听独立端口（默认 `8080/8443`，可自定义），与本机 `80/443` 物理隔离，门户与发布链接自动携带端口。
   - **存量服务一键纳管 (`vibedock adopt`)**：宿主机或内网其他机器上已在运行的服务，只需执行 `vibedock adopt <id> --upstream http://127.0.0.1:8080 --name "存量系统"` 即可一键挂载独立子域名与门户卡片。
5. **代码与状态彻底分离（Unified `/var/lib/vibedock` State Root）**
   - Linux 生产环境将所有配置、SQLite 数据库、TLS 证书、Caddy/Nginx 动态路由、SSH 密钥与已部署应用统一收口在 `/var/lib/vibedock`（可通过 `VIBEDOCK_HOME` 定制），随时执行 `npm i -g vibedock` 升级 CLI 绝不覆盖线上数据。
6. **安全最小权限与受控运维审批**
   - 部署专用受限系统账号 `vibe-deploy`，仅通过 `sudoers` 白名单调用受控 CLI；内置在线 AI 运维助手，所有变更动作（重启进程、热重载网关）均需管理员显式批准并记录审计日志。

---

## 🛠️ `vibedock` CLI 完整命令手册

全局安装 `npm install -g vibedock` 后，可直接执行 `vibedock <command>` 管理全套服务端能力：

```bash
# 1. 一键安装 Ubuntu 生产底座 (Node 22 / Caddy / PM2 / uv / SSHD / cron / 受限部署账号与 sudoers)
sudo vibedock setup

# 2. 交互式或非交互式初始化配置、网关与数据库共存策略，并烘焙 AI Skill 包
sudo vibedock init [--yes] [--host 192.168.1.100] [--domain vd.example.com] \
  [--gateway-strategy reuse|dedicated-chain|dedicated-port|none] \
  [--db-strategy dedicated|reuse]

# 3. 签发 acme.sh (DNS-01) 泛域名 HTTPS 证书 (支持解析到内网 IP 的域名) 或绑定自定义证书
sudo vibedock tls --dns <dnspod|aliyun|cf> --secret-id <ID> --secret-key <KEY>
sudo vibedock tls --cert /var/lib/vibedock/certs/fullchain.pem --key /var/lib/vibedock/certs/privkey.pem

# 4. 全量底座体检 (含 DNS 泛解析与 HTTPS 证书检查) 与启动门户服务 (--daemon 使用 PM2 后台守护)
sudo vibedock doctor
sudo vibedock start --daemon

# 5. 数据库底座管理 (内置 Docker 容器 / 纳管本机或远程实例 / 项目直接绑定)
sudo vibedock db up [--types postgresql,mysql,mongodb,redis]   # 一键启动内置共享数据库容器
sudo vibedock db register postgresql --url "postgresql://..."  # 纳管本机已安装或远程/RDS 数据库实例
sudo vibedock db bind <project-id> --postgresql "postgres://..." # 为项目直接绑定已有数据库连接串 (无需 root 密码)
sudo vibedock db status                                        # 查看数据库状态、纳管模式与已开通项目列表
sudo vibedock db provision <project-id> [--types all]          # 为指定项目幂等开通独立库与受限账号
sudo vibedock db get <project-id> [--format json|env]          # 查看或导出项目的数据库连接串 (.env 格式)
sudo vibedock db down                                          # 停止内置共享数据库容器

# 6. 应用槽位分配、发布、存量服务纳管与下架
sudo vibedock alloc [project-id]                               # 查询下一个空闲端口 (40000-40999) 及项目已绑定的固定端口
sudo vibedock publish [publish.json]                           # 校验契约、生成 Caddy/Nginx 站点并热重载
sudo vibedock adopt <id> --upstream http://127.0.0.1:8080      # 一键纳管本机或内网已有服务并自动挂载子域名与门户卡片
sudo vibedock unpublish <project-id>                           # 一键下架项目、停止 PM2 进程并清理网关路由
sudo vibedock pack-skill                                       # 根据最新配置重新烘焙 /var/lib/vibedock/vibedock-deploy.zip
```

---

## 🤖 AI Skill 客户端 CLI (`scripts/client.mjs`)

下载解压到 `~/.claude/skills/vibedock-deploy` 后的 Skill 包内置了零依赖的纯 Node ESM 客户端 `scripts/client.mjs`，供 Claude Code / Codex / Cursor 自动调用：

```bash
# 1. 检查与服务器的 SSH 免密连通性与门户状态
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs check

# 2. 为项目分配固定端口、检查子域名，并按需一键开通数据库
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs alloc my-app
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs db provision my-app --types postgresql,redis --format env

# 3. 同步构建产物 (自动递归创建远端目录)、启动 PM2 进程并执行原子发布
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs upload ./dist /var/lib/vibedock/apps/my-app/releases/v1/web
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs publish ./publish.json

# 4. 查看远程 PM2 进程日志或一键下架项目
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs logs my-app --lines 60
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs unpublish my-app
```

---

## 🗂️ 服务端统一状态目录 (`/var/lib/vibedock`)

在 Linux 服务器上，VibeDock 的所有运行时数据与生成资产均收纳在 `/var/lib/vibedock` 下：

```text
/var/lib/vibedock/
├── vibedock.config.json       # 主配置文件 (0600)
├── catalog.json               # 应用目录与路由表
├── vibedock-auth.sqlite3      # 账号、会话与邀请码库 (0600, 含 WAL/SHM)
├── vibedock-chat.sqlite3      # AI 诊断会话与运维审批审计库 (0600, 含 WAL/SHM)
├── vibedock-deploy.zip        # 已烘焙好的团队专属 AI 部署 Skill 包 (0600)
├── keys/                      # SSH 免密部署密钥对 (0700)
├── certs/                     # 泛域名/自定义 TLS 证书与私钥 (0750 root:caddy)
├── acme/                      # acme.sh 客户端、CA 账户与自动续期配置 (0700)
├── caddy/sites/               # Caddy 动态导入的门户与应用路由配置 (*.caddy)
├── secrets/databases/         # 数据库管理员与各项目隔离凭据 (0700)
├── databases/                 # 共享数据库持久化卷与 .env.db
├── apps/                      # 团队已发布的全部应用代码与软链 (/var/lib/vibedock/apps/<id>)
└── deploy/                    # 受限部署账号 vibe-deploy 家目录 (.ssh 与 .pm2)
```

---

## 🖥️ Ubuntu 24.04 生产服务器 3 分钟部署

```bash
# 1. 全局安装 CLI 并一键配置生产底座
sudo npm install -g vibedock
sudo vibedock setup

# 2. 初始化域名 (若无域名可直接回车使用免配置的 <IP>.nip.io)
sudo vibedock init --domain vd.example.com --yes

# 3. (可选) 若使用真实域名，一键签发泛域名 HTTPS 证书并开启自动续期
sudo vibedock tls --dns dnspod --secret-id <ID> --secret-key <KEY>

# 4. 启动门户守护进程并执行全量自检
sudo vibedock start --daemon
sudo vibedock doctor
```

---

## 📦 Monorepo 开发与构建指南

| 包路径 | 包名 | 说明 |
| :--- | :--- | :--- |
| [`packages/vibedock`](./packages/vibedock) | `vibedock` | Hono + TypeScript 服务端、`vibedock` CLI、Skill 模板与 Docker 数据库编排 |
| [`packages/web`](./packages/web) | `@vibedock/web` | React 19 + Vite + TypeScript 门户前端（构建产物输出至 `packages/vibedock/public`） |
| [`packages/docs`](./packages/docs) | `@vibedock/docs` | VitePress 官方文档站 |

```bash
pnpm install
pnpm build       # 构建前端 (@vibedock/web) 与服务端 (vibedock)
pnpm test        # 运行全量自动化测试 (30 项单元与集成测试)
pnpm dev:server  # 启动本地开发门户 (默认监听 http://127.0.0.1:39090)
pnpm docs:dev    # 启动 VitePress 文档站
```

## 📄 License

[MIT](./LICENSE)
