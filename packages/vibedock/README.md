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
3. **4 大数据库一键按项目隔离（Shared Database Fleet）**
   - 单机 Docker Compose 统一托管 **PostgreSQL 16**、**MySQL 8.0**、**MongoDB 8.0**、**Redis 7.2**，全部强制仅绑定 `127.0.0.1` 回环地址，绝不向公网暴露裸端口。
   - 按项目幂等自动创建独立 Database、独立受限账号及 Redis ACL 键空间前缀（`vibe_<project>:*`），并可一键导出 `db.env`。
4. **代码与状态彻底分离（Unified `/var/lib/vibedock` State Root）**
   - Linux 生产环境将所有配置、SQLite 数据库、TLS 证书、Caddy 动态路由、SSH 密钥与已部署应用统一收口在 `/var/lib/vibedock`（可通过 `VIBEDOCK_HOME` 定制），随时执行 `npm i -g vibedock` 升级 CLI 绝不覆盖线上数据。
5. **安全最小权限与受控运维审批**
   - 部署专用受限系统账号 `vibe-deploy`，仅通过 `sudoers` 白名单调用受控 CLI；内置在线 AI 运维助手，所有变更动作（重启进程、热重载网关）均需管理员显式批准并记录审计日志。

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

## 🛠️ `vibedock` CLI 完整命令手册

```bash
# 1. 一键安装 Ubuntu 生产底座 (Node 22 / Caddy / PM2 / uv / SSHD / cron / 受限部署账号与 sudoers)
sudo vibedock setup

# 2. 交互式或非交互式初始化配置、随机数据库管理员密码、SSH 部署密钥对并烘焙 AI Skill 包
sudo vibedock init [--yes] [--host 192.168.1.100] [--domain vd.example.com]

# 3. 签发 acme.sh (DNS-01) 泛域名 HTTPS 证书 (支持解析到内网 IP 的域名) 或绑定自定义证书
sudo vibedock tls --dns <dnspod|aliyun|cf> --secret-id <ID> --secret-key <KEY>
sudo vibedock tls --cert /var/lib/vibedock/certs/fullchain.pem --key /var/lib/vibedock/certs/privkey.pem

# 4. 全量底座体检 (含 DNS 泛解析与 HTTPS 证书检查) 与启动门户服务 (--daemon 使用 PM2 后台守护)
sudo vibedock doctor
sudo vibedock start --daemon

# 5. 共享数据库底座管理 (Docker Compose: PostgreSQL / MySQL / MongoDB / Redis)
sudo vibedock db up [--types postgresql,mysql,mongodb,redis]   # 一键启动共享数据库容器
sudo vibedock db status                                        # 查看数据库容器状态与已开通项目列表
sudo vibedock db provision <project-id> [--types all]          # 为指定项目幂等开通独立库与受限账号
sudo vibedock db get <project-id> [--format json|env]          # 查看或导出项目的数据库连接串 (.env 格式)
sudo vibedock db down                                          # 停止共享数据库容器

# 6. 应用槽位分配、发布与下架 (供管理员或受控 sudoers 网关调用)
sudo vibedock alloc [project-id]                               # 查询下一个空闲端口 (40000-40999) 及项目已绑定的固定端口
sudo vibedock publish [publish.json]                           # 校验契约、生成 Caddy 站点并热重载
sudo vibedock unpublish <project-id>                           # 一键下架项目、停止 PM2 进程并清理 Caddy 路由
sudo vibedock pack-skill                                       # 根据最新配置重新烘焙 /var/lib/vibedock/vibedock-deploy.zip
```

## 📄 License

MIT
