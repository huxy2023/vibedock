---
layout: home

hero:
  name: VibeDock
  text: AI-Native 团队私有云与演示门户
  tagline: 专为 Vibe Coding 团队打造：装一次 Skill，对 Claude Code / Codex / Cursor 说句话，自动分配独立子域名、泛域名 HTTPS 证书、空闲端口、PM2 守护进程与 4 大数据库。
  actions:
    - theme: brand
      text: 5 分钟快速开始 →
      link: /guide/getting-started
    - theme: alt
      text: 浏览架构设计
      link: /guide/architecture

features:
  - icon: 🤖
    title: 零依赖 AI Deploy Skill
    details: 门户一键打包下载 vibedock-deploy.zip（内置 SSH 密钥与纯 Node ESM client.mjs），AI 编程助手一条命令完成端口分配、rsync 同步与发布。
  - icon: 🔒
    title: 公网与内网泛域名 HTTPS 自动托管
    details: 支持 Caddy Auto-HTTPS 与 vibedock tls --dns (acme.sh DNS-01)，内网 IP 服务器也可一条命令签发 *.domain 泛域名证书并开启 cron 自动续期。
  - icon: 🗄️
    title: 4 大数据库按项目秒级开通
    details: 单机 Docker Compose 托管 PostgreSQL 16、MySQL 8.0、MongoDB 8.0、Redis 7.2，全部仅绑定 127.0.0.1，按项目自动生成独立库、账号与 secrets/db.env。
  - icon: 🛡️
    title: 统一状态收口与最小权限
    details: 服务端所有配置、证书、SQLite 与应用统一收口于 /var/lib/vibedock，npm 升级绝不丢数据；受限账号 vibe-deploy 仅通过 sudoers 白名单发布。
---
