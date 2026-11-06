---
name: {{SKILL_NAME}}
description: 用专用受限账号将静态前端、Node.js、Python (uv) 或 Go 应用一键部署到团队自建服务器 ({{SERVER_HOST}})，支持自动分配空闲端口（alloc）、按项目自助开通共用 PostgreSQL/MySQL/MongoDB/Redis 数据库、查看 PM2 诊断日志（logs）、下线废弃应用（unpublish），并自动登记到 {{BRAND_NAME}} 门户。
---

# {{BRAND_NAME}} 团队应用与数据库部署（{{SKILL_NAME}}）

用户给出本地项目路径，按此 Skill 完成自动分配端口、项目数据库开通、应用构建上传、网关域名接入、门户登记与在线验证。包内 `access/` 目录已内置服务器连接配置（`server.json`）与专用 SSH 密钥（`deploy_key`），无需用户手动配置 SSH。

## 支持的技术栈与范围

- **静态站点 (`kind: "static"`)**：HTML、React/Vue/Vite SPA、Next.js/Astro 静态导出、Docusaurus/VitePress 文档站。
- **通用本地端口服务 (`kind: "service"`，统一监听 `127.0.0.1:{{PORT_START}}–{{PORT_END}}`，由 PM2 守护)**：
  1. **Node.js (`runtime: "node"`)**：HTTP API、WebSocket、SSR（`pm2 start server.mjs --name {{APP_PREFIX}}<id>-api`）；
  2. **Python (`runtime: "python"`, `uv`)**：FastAPI / Flask / Django / AI Agent 服务（使用 `uv sync` 自动管理独立虚拟环境，通过 `pm2 start .venv/bin/uvicorn --name {{APP_PREFIX}}<id>-api --interpreter none -- main:app --host 127.0.0.1 --port <port>` 启动）；
  3. **Go (`runtime: "go"`)**：在本地交叉编译为 Linux 单二进制文件（`CGO_ENABLED=0 GOOS=linux GOARCH=<amd64|arm64> go build -o app .`）后上传至服务器，通过 `pm2 start ./app --name {{APP_PREFIX}}<id>-api` 启动。
- **共用数据库（PostgreSQL 16 `5432`、MySQL 8.0 `3306`、MongoDB 8.0 `27017`、Redis 7.2 `6379`）**：通过 `node scripts/client.mjs db` 按项目一键开通独立库/账号与 Redis ACL Key 前缀权限。

不支持修改宿主机系统级配置、跨项目读写其他同事数据库或执行 `pm2 delete/restart all`。

## 核心固定命令

所有命令均在本 Skill 目录下通过零依赖 Node 客户端 `scripts/client.mjs` 执行：

```bash
# 1. 检查连接状态与门户健康度
node scripts/client.mjs check

# 2. 自动检查项目 ID 并获取推荐空闲端口 ({{PORT_START}}–{{PORT_END}})
node scripts/client.mjs alloc <id>

# 3. 查看或开通项目专属数据库 (postgresql,mysql,mongodb,redis)
node scripts/client.mjs db status
node scripts/client.mjs db provision <id> --types postgresql,redis

# 4. 查看项目 PM2 进程状态与最近日志
node scripts/client.mjs logs <id> --lines 60

# 5. 发布或下线应用路由与门户卡片
node scripts/client.mjs publish /path/to/publish.json
node scripts/client.mjs unpublish <id>
```

执行前请阅读 [references/deploy.md](references/deploy.md)；若项目使用数据库，同时阅读 [references/database.md](references/database.md)。

## 标准工作顺序

1. 检查本地项目结构与技术栈（Static / Node.js / Python `uv` / Go）及所需数据库。
2. 运行 `node scripts/client.mjs alloc <id>` 获取推荐空闲端口 `recommendedPort`。
3. 如需数据库，运行 `node scripts/client.mjs db provision <id> --types ...` 并将环境变量写入 `{{APPS_DIR}}/<id>/secrets/db.env`（权限 `600`）。
4. 上传构建产物或源码至 `{{APPS_DIR}}/<id>/releases/<release-id>/`，并在服务器端完成依赖安装（Node `npm ci` / Python `uv sync`；Go 在本地交叉编译为 Linux 单二进制后直接上传）。
5. 启动或更新具名 PM2 进程 `{{APP_PREFIX}}<id>-<component>`（监听 `127.0.0.1:<port>`）并执行 `pm2 save`。
6. 原子切换 `{{APPS_DIR}}/<id>/current` 软链，生成 `publish.json` 并调用 `node scripts/client.mjs publish` 完成域名与门户登记。
7. 验证内部健康检查、线上访问地址（`{{PRIMARY_DOMAIN}}`）及门户（`{{PORTAL_URL}}`）展示状态。
