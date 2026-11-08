# publish.json 与 Skill 部署契约

## 1. 统一零依赖客户端 (`scripts/client.mjs`)

VibeDock 在 `vibedock-deploy` Skill 包内提供统一的纯 Node.js ESM 客户端 `scripts/client.mjs`（无需在开发者电脑安装任何第三方 npm 依赖）：

```bash
# 1. 探测服务器 SSH 免密连通性与门户健康度
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs check

# 2. 为项目分配固定端口 (40000-40999) 并检查子域名
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs alloc my-app

# 3. 按需为项目一键开通独立数据库 (自动输出 .env 格式连接串)
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs db provision my-app --types postgresql,redis --format env

# 4. 上传构建产物 (自动在远端创建目标目录，且目录上传自动对齐内容不额外嵌套)
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs upload ./dist /var/lib/vibedock/apps/my-app/releases/v1/web

# 5. 在受限账号下启动/更新 PM2 守护进程并切换 current 软链
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs exec 'ln -sfn /var/lib/vibedock/apps/my-app/releases/v1 /var/lib/vibedock/apps/my-app/current'

# 6. 提交 publish.json 原子生成 Caddy/Nginx 路由、挂载 HTTPS 证书并登记门户卡片
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs publish ./publish.json

# 6b. 或一键纳管宿主机/内网已运行的存量服务 (无需上传代码目录，直接分配子域名与门户卡片)
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs adopt legacy-erp --upstream http://127.0.0.1:18080 --name "存量 ERP 系统"

# 7. 查看远程 PM2 日志或一键下架应用
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs logs my-app --lines 80
node ~/.claude/skills/vibedock-deploy/scripts/client.mjs unpublish my-app
```

---

## 2. `publish.json` 字段规范

支持前后端分离合体（`static` + `service`）、纯后端/全栈单服务（`service`）或纯静态站点（`static`）：

```json
{
  "id": "my-app",
  "name": "智能周报生成器",
  "category": "AI 工具",
  "owner": "张三",
  "description": "基于大模型的团队周报自动汇总服务",
  "tags": ["PostgreSQL", "Node.js"],
  "components": [
    {
      "id": "web",
      "kind": "static",
      "root": "web",
      "routing": "spa"
    },
    {
      "id": "api",
      "kind": "service",
      "runtime": "node",
      "port": 40001
    }
  ],
  "routes": [
    { "component": "api", "host": "main", "path": "/api/*" },
    { "component": "web", "host": "main", "path": "/*" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 小写字母、数字与连字符（`2-40` 位），自动映射子域名 `team-<id>.<primaryDomain>` |
| `name` | `string` | 是 | 展示在 VibeDock 门户上的应用名称 |
| `components` | `Array` | 是 | 组件列表：`kind: "static"`（静态目录，支持 `routing: "spa"`）、`kind: "service"`（监听 `127.0.0.1:<port>` 的常驻进程）或 `kind: "external"`（通过 `upstream: "http://host:port"` 纳管本机/内网已有服务） |
| `routes` | `Array` | 否 | 路由匹配规则（如 `/api/*` 转发给 `api` 组件，`/*` 转发给 `web` 组件） |
| `owner` | `string` | 否 | 负责人姓名或团队名称 |
| `tags` | `string[]` | 否 | 门户卡片展示的技术栈或业务标签 |
