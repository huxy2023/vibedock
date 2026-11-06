# 一键数据库底座与隔离机制

## 1. 4 大共享数据库实例

VibeDock 通过 `packages/vibedock/docker/docker-compose.db.yml` 统一编排 4 大主流数据库，全部仅绑定宿主机回环地址 `127.0.0.1`，不向公网或局域网暴露裸端口：

| 数据库引擎 | 容器名 | 宿主机监听 | 隔离策略 |
| :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | `vibedock-postgres` | `127.0.0.1:5432` | 每项目独立 Role + 独立 Database (`vibe_<id>`) |
| **MySQL 8.0** | `vibedock-mysql` | `127.0.0.1:3306` | 每项目独立 User + 独立 Database (`vibe_<id>`) |
| **MongoDB 8.0** | `vibedock-mongodb` | `127.0.0.1:27017` | 每项目独立 `readWrite` User + 独立 Database (`vibe_<id>`) |
| **Redis 7.2** | `vibedock-redis` | `127.0.0.1:6379` | Redis 7 ACL 独立用户，限制仅可访问 `vibe_<id>:*` 键空间 |

---

## 2. 按项目自助开通与注入环境变量 (`secrets/db.env`)

团队成员可通过 Skill 客户端 `scripts/client.mjs db provision` 按项目一键开通所需数据库，并将返回的环境变量写入 `/var/lib/vibedock/apps/<id>/secrets/db.env`（权限 `0600`）：

```bash
# 开通 PostgreSQL 与 Redis 并写入项目私密环境变量文件
node scripts/client.mjs exec "mkdir -p /var/lib/vibedock/apps/my-app/secrets && chmod 700 /var/lib/vibedock/apps/my-app/secrets"
node scripts/client.mjs db provision my-app --types postgresql,redis --format env | \
  node scripts/client.mjs exec "umask 077 && cat > /var/lib/vibedock/apps/my-app/secrets/db.env"
```

生成的 `db.env` 格式如下：

```dotenv
# PostgreSQL
DATABASE_URL="postgresql://vibe_my_app:xxxx@127.0.0.1:5432/vibe_my_app"
POSTGRES_URL="postgresql://vibe_my_app:xxxx@127.0.0.1:5432/vibe_my_app"

# MySQL
MYSQL_URL="mysql://vibe_my_app:xxxx@127.0.0.1:3306/vibe_my_app"

# MongoDB
MONGODB_URL="mongodb://vibe_my_app:xxxx@127.0.0.1:27017/vibe_my_app?authSource=vibe_my_app"

# Redis
REDIS_URL="redis://vibe_my_app:xxxx@127.0.0.1:6379"
REDIS_KEY_PREFIX="vibe_my_app:"
```
