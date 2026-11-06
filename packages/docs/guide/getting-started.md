# 5 分钟快速开始

## 1. 环境要求

- **操作系统**：Ubuntu 22.04 / 24.04 LTS（生产服务端）或 macOS / Linux（本地开发）
- **Node.js**：`>= 22.5.0`（使用内置 `node:sqlite`，零原生 C++ 编译依赖）
- **生产底座组件**（由 `sudo vibedock setup` 一键自动安装）：`Caddy`、`PM2`、`uv`、`rsync`、`zip`、`cron`、`openssh-server`

---

## 2. Ubuntu 生产服务器 3 分钟一键部署（推荐）

在团队共享的 Ubuntu 服务器上执行：

```bash
# 1. 全局安装 VibeDock CLI 并自动配置 Ubuntu 生产底座
sudo npm install -g vibedock
sudo vibedock setup

# 2. 初始化配置、随机数据库管理员密码、SSH 免密部署密钥对并烘焙 AI Skill 包
#    (若暂未配置域名，可省略 --domain，默认自动使用免 DNS 的 <服务器IP>.nip.io)
sudo vibedock init --domain vd.example.com --yes

# 3. [可选] 若使用真实域名（含解析到内网 IP 的域名），一条命令签发泛域名 HTTPS 证书并注册自动续期
sudo vibedock tls --dns dnspod --secret-id <SecretId> --secret-key <SecretKey>

# 4. 启动门户后台守护进程并执行全量自检
sudo vibedock start --daemon
sudo vibedock doctor
```

::: tip 内网 IP 服务器的泛域名 HTTPS 证书方案
当服务器位于企业内网（如 `192.168.x.x` 或 `10.x.x.x`）时，公网 HTTP-01 验证无法穿透内网。只需在 DNS 服务商（腾讯云/DNSPod `dnspod`、阿里云 `aliyun`、Cloudflare `cf`）添加 `portal.<domain>` 与 `*.<domain>` 两条 A 记录指向内网 IP，再执行 `sudo vibedock tls --dns <provider>`，VibeDock 即可通过 DNS-01 自动签发 `*.<domain>` 通配符证书并配置 `cron` 自动续期。之后团队成员部署任何新应用均自动启用 HTTPS！
:::

---

## 3. 团队成员一键安装 AI Deploy Skill

初始化完成后，终端会直接输出带团队邀请码的一键下载命令（也可登录门户在 **「部署与数据库」** 页面复制）：

```bash
mkdir -p ~/.claude/skills
curl -fsSL "https://portal.vd.example.com/api/dx/skill-package?code=<团队邀请码>" -o /tmp/vibedock-deploy.zip
unzip -qo /tmp/vibedock-deploy.zip -d ~/.claude/skills/
```

随后只需在本地项目目录里对 Claude Code / Codex / Cursor 说：

> “用 vibedock-deploy 把当前项目部署上线，申请一个 PostgreSQL 和 Redis 数据库。”

---

## 4. 本地源码开发启动（macOS / Linux 零系统侵入）

在非 Linux 生产环境或未创建 `/var/lib/vibedock` 的开发机上，VibeDock 会将所有 SQLite、配置文件与密钥收敛在仓库的 `packages/vibedock/data/` 目录内，**绝不触碰宿主机 `/etc` 或 `/var/lib`**：

```bash
pnpm install
pnpm build
npx vibedock init --yes --host 127.0.0.1 --domain 127.0.0.1.nip.io
pnpm dev:server
```
