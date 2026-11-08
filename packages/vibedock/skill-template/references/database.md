# 共用数据库服务（PostgreSQL / MySQL / MongoDB / Redis）

服务器（`{{SERVER_HOST}}`）通过 Docker Compose 提供四类共用数据库服务，支持通过 `node scripts/client.mjs db` 按项目一键开通独立数据库/账号与 Redis ACL 前缀权限。

## 1. 常用命令

```bash
# 1. 查看四类数据库运行状态
node scripts/client.mjs db status

# 2. 按需为项目开通专属数据库（支持 postgresql,mysql,mongodb,redis 或 all）
node scripts/client.mjs db provision demo --types postgresql,redis

# 2b. 或直接为项目绑定已有的外部数据库连接串（无需管理员密码）
node scripts/client.mjs db bind demo --postgresql "postgresql://user:pass@host:5432/dbname" --redis "redis://:pass@host:6379/1"

# 3. 导出 .env 格式并写入服务器项目私有 secrets 目录
node scripts/client.mjs exec 'mkdir -p -m 700 {{APPS_DIR}}/demo/secrets'
node scripts/client.mjs db get demo --format env | node scripts/client.mjs exec 'umask 077 && cat > {{APPS_DIR}}/demo/secrets/db.env'

# 4. 验证项目数据库配置
node scripts/client.mjs db verify demo
```

## 2. 隔离规则与标准环境变量

每个项目 `<id>` 自动分配独立数据库与专属账号 `proj_<slug>`（连字符转下划线）：
- **PostgreSQL (`5432`)**：`POSTGRES_URL`
- **MySQL (`3306`)**：`MYSQL_URL`
- **MongoDB (`27017`)**：`MONGODB_URI`
- **Redis (`6379`)**：`REDIS_URL`, `REDIS_KEY_PREFIX`（强制 `<id>:` 前缀）
