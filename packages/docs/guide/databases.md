# 一键数据库底座与三档灵活接入

## 1. 三档灵活接入模式（Built-in Docker / 存量实例纳管 / 项目连接串直绑）

无论你的服务器是全新裸机，还是已经装有数据库或使用内网/云 RDS，VibeDock 均提供无侵入的三档接入方式：

1. **档位 1：零配置内置 Docker 容器（`vibedock db up`）**
   通过 `packages/vibedock/docker/docker-compose.db.yml` 一键启动 4 大主流数据库，全部仅绑定宿主机回环地址 `127.0.0.1`，不向公网或局域网暴露裸端口。
2. **档位 2：纳管宿主机已安装或远程/RDS 实例（`vibedock db register`）**
   若服务器本机已装有 PostgreSQL/MySQL/MongoDB/Redis 或团队已有内网数据库，无需启动内置容器，直接注册管理员连接信息：
   ```bash
   sudo vibedock db register postgresql --url "postgresql://postgres:pass@127.0.0.1:5432/postgres"
   sudo vibedock db register redis --host 127.0.0.1 --port 6379
   ```
   注册后，开发者执行 `db provision <project>` 会自动连接该存量实例为项目创建独立 Database、受限账号与 Redis ACL 前缀。
3. **档位 3：项目级直接绑定现成连接串（`vibedock db bind`，无需管理员 root 密码）**
   若某个项目需要直连现成的外部库（只有业务账号、没有 DBA 管理员密码），可直接绑定：
   ```bash
   node scripts/client.mjs db bind my-app --postgresql "postgresql://user:pass@rds.internal:5432/mydb" --redis "redis://:pass@127.0.0.1:6379/2"
   ```

| 数据库引擎 | 默认容器名 | 默认监听 | 按项目隔离策略 (`db provision`) |
| :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | `vibedock-postgres` | `127.0.0.1:5432` | 每项目独立 Role + 独立 Database (`proj_<id>`) |
| **MySQL 8.0** | `vibedock-mysql` | `127.0.0.1:3306` | 每项目独立 User + 独立 Database (`proj_<id>`) |
| **MongoDB 8.0** | `vibedock-mongodb` | `127.0.0.1:27017` | 每项目独立 `readWrite` User + 独立 Database (`proj_<id>`) |
| **Redis 7.2** | `vibedock-redis` | `127.0.0.1:6379` | Redis 7 ACL 独立用户，限制仅可访问 `<id>:*` 键空间 |

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
