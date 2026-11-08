# 发布步骤与多语言服务契约（Node.js / Python `uv` / Go / 静态站）

在 Skill 目录下执行命令。`scripts/client.mjs` 自动读取 `access/server.json` 与 `access/deploy_key`。

## 1. 预检与自动分配空闲端口

```bash
node scripts/client.mjs check
node scripts/client.mjs alloc <id>
```

`alloc` 会自动检查项目 ID 并返回推荐空闲端口 `recommendedPort`（位于 `{{PORT_START}}–{{PORT_END}}` 之间；若项目已存在则自动复用原端口）以及发布后的访问 URL。

## 2. 目录结构与上传

```text
{{APPS_DIR}}/<id>/
├── releases/<release-id>/
│   ├── web/       # 静态前端产物 (含 index.html)
│   └── api/       # 后端代码 (Node.js / Python uv / Go)
├── current -> releases/<release-id>
├── data/          # 持久化文件目录
├── secrets/       # 权限 700，db.env 权限 600
└── publish.json
```

上传文件：
```bash
node scripts/client.mjs upload ./dist {{APPS_DIR}}/demo/releases/v1/web
```

## 3. 启动后端服务（Node.js / Python `uv` / Go 通用端口契约）

所有后端服务统一遵循：**监听 `127.0.0.1:<port>`，由 PM2 以 `{{APP_PREFIX}}<id>-<component>` 进程名守护**。

### 方式 A：Node.js 服务
```bash
node scripts/client.mjs exec 'cd {{APPS_DIR}}/demo/releases/v1/api && ( [ ! -f package.json ] || npm ci --omit=dev ) && if [ -f {{APPS_DIR}}/demo/secrets/db.env ]; then set -a; . {{APPS_DIR}}/demo/secrets/db.env; set +a; fi && HOST=127.0.0.1 PORT=40001 NODE_ENV=production pm2 start server.mjs --name {{APP_PREFIX}}demo-api && pm2 save'
```

### 方式 B：Python 服务（推荐使用 `uv`）
```bash
node scripts/client.mjs exec 'cd {{APPS_DIR}}/demo/releases/v1/api && uv sync && if [ -f {{APPS_DIR}}/demo/secrets/db.env ]; then set -a; . {{APPS_DIR}}/demo/secrets/db.env; set +a; fi && pm2 start .venv/bin/uvicorn --name {{APP_PREFIX}}demo-api --interpreter none -- main:app --host 127.0.0.1 --port 40001 && pm2 save'
```

### 方式 C：Go 服务（本地交叉编译为 Linux 单二进制文件后上传）
```bash
# 1. 自动识别服务器 CPU 架构 (aarch64 -> arm64, x86_64 -> amd64)，在本地交叉编译并上传
ARCH=$(node scripts/client.mjs exec 'uname -m' | tr -d '\r\n')
GOARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "amd64")
CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH go build -o ./dist-api/app .
node scripts/client.mjs upload ./dist-api {{APPS_DIR}}/demo/releases/v1/api

# 2. 在服务器端赋权并交由 PM2 守护启动
node scripts/client.mjs exec 'cd {{APPS_DIR}}/demo/releases/v1/api && chmod +x ./app && if [ -f {{APPS_DIR}}/demo/secrets/db.env ]; then set -a; . {{APPS_DIR}}/demo/secrets/db.env; set +a; fi && HOST=127.0.0.1 PORT=40001 pm2 start ./app --name {{APP_PREFIX}}demo-api && pm2 save'
```

切换 `current` 软链：
```bash
node scripts/client.mjs exec 'ln -sfn {{APPS_DIR}}/demo/releases/v1 {{APPS_DIR}}/demo/current'
```

查看 PM2 状态与最近日志：
```bash
node scripts/client.mjs logs demo --lines 80
```

## 4. 切换 `current` 并登记 `publish.json`

`components[].kind` 统一为 `"static"` 或 `"service"`（当 `kind: "service"` 时，可通过 `runtime: "node" | "python" | "go"` 标注运行时）：

```json
{
  "id": "demo",
  "name": "演示项目",
  "description": "一句话说明项目用途",
  "owner": "开发者姓名",
  "tags": ["PostgreSQL", "FastAPI"],
  "components": [
    {"id": "web", "kind": "static", "root": "web", "routing": "spa"},
    {"id": "api", "kind": "service", "runtime": "python", "port": 40001}
  ],
  "routes": [
    {"component": "web", "host": "main", "path": "/*"},
    {"component": "api", "host": "main", "path": "/api/*"}
  ]
}
```

执行发布、一键纳管存量服务或下线：
```bash
# 常规发布
node scripts/client.mjs publish /path/to/publish.json

# 一键纳管宿主机或内网已运行的存量服务 (无需上传代码目录，直接分配子域名与门户卡片)
node scripts/client.mjs adopt legacy-app --upstream http://127.0.0.1:8080 --name "存量业务系统"

# 下线项目
node scripts/client.mjs unpublish demo
```
