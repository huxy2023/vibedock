import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { urllibQuote, withFileLock, writeFileAtomic } from './utils.js';
import type { VibeDockConfig } from '../types.js';

const PROJECT_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SUPPORTED_TYPES = new Set(['postgresql', 'mysql', 'mongodb', 'redis']);

export interface ProvisionedDbEntry {
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  envKey: string;
  url: string;
  keyPrefix?: string;
  bound?: boolean;
}

function randomSecret(len = 24): string {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function normalizeProject(raw: string): string {
  const p = String(raw || '').trim().toLowerCase();
  if (!PROJECT_RE.test(p)) {
    throw new Error('Invalid project id: use 1-32 lowercase letters, digits, or hyphens');
  }
  return p;
}

function safeIdentifier(project: string): string {
  return `proj_${project.replaceAll('-', '_')}`;
}

function loadAdminCreds(cfg: VibeDockConfig): Record<string, any> {
  const adminFile = path.join(cfg.paths.dbSecretsDir, 'admin.json');
  if (!fs.existsSync(adminFile)) {
    throw new Error(`Database admin credentials missing at ${adminFile}. Run "vibedock init" first.`);
  }
  return JSON.parse(fs.readFileSync(adminFile, 'utf8'));
}

function isContainerRunning(container: string): boolean {
  const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8', timeout: 3000 });
  return inspect.status === 0 && inspect.stdout.trim() === 'true';
}

function runDockerExec(container: string, args: string[], inputText?: string) {
  if (!isContainerRunning(container)) {
    throw new Error(`Docker 数据库容器 ${container} 未启动，请先执行 "vibedock db up" 或使用 "vibedock db register" 接入已有数据库`);
  }
  const cmd = inputText !== undefined
    ? ['exec', '-i', container, ...args]
    : ['exec', container, ...args];
  const res = spawnSync('docker', cmd, {
    input: inputText,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `${container} command failed`).trim());
  }
  return res.stdout;
}

function runClientCmd(
  bin: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; dockerImage?: string } = {},
): string {
  const hasLocalBin = spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
  if (hasLocalBin) {
    const res = spawnSync(bin, args, {
      input: options.input,
      env: { ...process.env, ...(options.env || {}) },
      encoding: 'utf8',
      timeout: 15000,
    });
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || `${bin} command failed`).trim());
    }
    return res.stdout;
  }
  if (options.dockerImage) {
    const envArgs = Object.entries(options.env || {}).flatMap(([k, v]) => (v !== undefined ? ['-e', `${k}=${v}`] : []));
    const dArgs = ['run', '--rm', '--network', 'host', ...(options.input !== undefined ? ['-i'] : []), ...envArgs, options.dockerImage, bin, ...args];
    const res = spawnSync('docker', dArgs, {
      input: options.input,
      encoding: 'utf8',
      timeout: 20000,
    });
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || `${bin} via docker failed`).trim());
    }
    return res.stdout;
  }
  throw new Error(`未检测到客户端工具 "${bin}"，请先安装对应客户端或使用 "vibedock db bind" 直接绑定现成连接串`);
}

function runDockerExecBuffer(container: string, args: string[]): Buffer {
  if (!isContainerRunning(container)) {
    throw new Error(`Docker 数据库容器 ${container} 未启动，请先执行 "vibedock db up" 或使用 "vibedock db register" 接入已有数据库`);
  }
  const res = spawnSync('docker', ['exec', container, ...args], {
    timeout: 15000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(((res.stderr && res.stderr.toString('utf8')) || (res.stdout && res.stdout.toString('utf8')) || `${container} command failed`).trim());
  }
  return Buffer.from(res.stdout || []);
}

function runClientCmdBuffer(
  bin: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; dockerImage?: string } = {},
): Buffer {
  const hasLocalBin = spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
  if (hasLocalBin) {
    const res = spawnSync(bin, args, {
      env: { ...process.env, ...(options.env || {}) },
      timeout: 15000,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (res.status !== 0) {
      throw new Error(((res.stderr && res.stderr.toString('utf8')) || (res.stdout && res.stdout.toString('utf8')) || `${bin} command failed`).trim());
    }
    return Buffer.from(res.stdout || []);
  }
  if (options.dockerImage) {
    const envArgs = Object.entries(options.env || {}).flatMap(([k, v]) => (v !== undefined ? ['-e', `${k}=${v}`] : []));
    const dArgs = ['run', '--rm', '--network', 'host', ...envArgs, options.dockerImage, bin, ...args];
    const res = spawnSync('docker', dArgs, {
      timeout: 20000,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (res.status !== 0) {
      throw new Error(((res.stderr && res.stderr.toString('utf8')) || (res.stdout && res.stdout.toString('utf8')) || `${bin} via docker failed`).trim());
    }
    return Buffer.from(res.stdout || []);
  }
  throw new Error(`未检测到客户端工具 "${bin}"，请先安装对应客户端或使用 "vibedock db bind" 直接绑定现成连接串`);
}

function resolveTargetHost(cfg: VibeDockConfig, adminHost?: string, useDocker = true): string {
  const h = String(adminHost || '127.0.0.1').trim();
  if (!useDocker) return h;
  return h === '127.0.0.1' || h === 'localhost' ? cfg.serverHost : h;
}

function provisionPostgresql(cfg: VibeDockConfig, admin: Record<string, any>, ident: string, password: string): ProvisionedDbEntry {
  const pgAdmin = admin.postgresql || {};
  const adminHost = String(pgAdmin.host || '127.0.0.1').trim();
  const port = Number(pgAdmin.port || 5432);
  const adminUser = pgAdmin.user || 'postgres';
  const adminPassword = String(pgAdmin.password || '');
  const sql = `
DO $do$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${ident}') THEN
      CREATE ROLE ${ident} LOGIN PASSWORD '${password}';
   ELSE
      ALTER ROLE ${ident} WITH LOGIN PASSWORD '${password}';
   END IF;
END
$do$;
SELECT 'CREATE DATABASE ${ident} OWNER ${ident}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${ident}')\\gexec
GRANT ALL PRIVILEGES ON DATABASE ${ident} TO ${ident};
`;
  const grantSql = `GRANT ALL ON SCHEMA public TO ${ident};\n`;
  const useDocker = pgAdmin.mode !== 'external' && isContainerRunning('vibedock-postgres');
  if (useDocker) {
    runDockerExec('vibedock-postgres', ['psql', '-v', 'ON_ERROR_STOP=1', '-U', adminUser, '-d', 'postgres'], sql);
    runDockerExec('vibedock-postgres', ['psql', '-v', 'ON_ERROR_STOP=1', '-U', adminUser, '-d', ident], grantSql);
  } else {
    runClientCmd('psql', ['-v', 'ON_ERROR_STOP=1', '-h', adminHost, '-p', String(port), '-U', adminUser, '-d', 'postgres'], {
      input: sql,
      env: { PGPASSWORD: adminPassword },
      dockerImage: 'postgres:16-alpine',
    });
    runClientCmd('psql', ['-v', 'ON_ERROR_STOP=1', '-h', adminHost, '-p', String(port), '-U', adminUser, '-d', ident], {
      input: grantSql,
      env: { PGPASSWORD: adminPassword },
      dockerImage: 'postgres:16-alpine',
    });
  }
  const host = resolveTargetHost(cfg, adminHost, useDocker);
  return {
    type: 'postgresql',
    host,
    port,
    database: ident,
    username: ident,
    password,
    envKey: 'POSTGRES_URL',
    url: `postgresql://${ident}:${urllibQuote(password)}@${host}:${port}/${ident}`,
  };
}

function provisionMysql(cfg: VibeDockConfig, admin: Record<string, any>, ident: string, password: string): ProvisionedDbEntry {
  const myAdmin = admin.mysql || {};
  const adminHost = String(myAdmin.host || '127.0.0.1').trim();
  const port = Number(myAdmin.port || 3306);
  const adminUser = myAdmin.user || 'root';
  const adminPassword = String(myAdmin.password || '');
  const sql = `
CREATE DATABASE IF NOT EXISTS \`${ident}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${ident}'@'%' IDENTIFIED BY '${password}';
ALTER USER '${ident}'@'%' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON \`${ident}\`.* TO '${ident}'@'%';
FLUSH PRIVILEGES;
`;
  const useDocker = myAdmin.mode !== 'external' && isContainerRunning('vibedock-mysql');
  if (useDocker) {
    runDockerExec('vibedock-mysql', ['mysql', `-u${adminUser}`, `-p${adminPassword}`], sql);
  } else {
    runClientCmd('mysql', ['-h', adminHost, '-P', String(port), `-u${adminUser}`, `-p${adminPassword}`], {
      input: sql,
      dockerImage: 'mysql:8.0',
    });
  }
  const host = resolveTargetHost(cfg, adminHost, useDocker);
  return {
    type: 'mysql',
    host,
    port,
    database: ident,
    username: ident,
    password,
    envKey: 'MYSQL_URL',
    url: `mysql://${ident}:${urllibQuote(password)}@${host}:${port}/${ident}`,
  };
}

function provisionMongodb(cfg: VibeDockConfig, admin: Record<string, any>, ident: string, password: string): ProvisionedDbEntry {
  const mgAdmin = admin.mongodb || {};
  const adminHost = String(mgAdmin.host || '127.0.0.1').trim();
  const port = Number(mgAdmin.port || 27017);
  const adminUser = mgAdmin.user || 'admin';
  const adminPassword = String(mgAdmin.password || '');
  const js = `
const targetDb = db.getSiblingDB(${JSON.stringify(ident)});
const existing = targetDb.getUser(${JSON.stringify(ident)});
if (!existing) {
  targetDb.createUser({
    user: ${JSON.stringify(ident)},
    pwd: ${JSON.stringify(password)},
    roles: [{ role: 'readWrite', db: ${JSON.stringify(ident)} }, { role: 'dbAdmin', db: ${JSON.stringify(ident)} }]
  });
} else {
  targetDb.changeUserPassword(${JSON.stringify(ident)}, ${JSON.stringify(password)});
}
`;
  const useDocker = mgAdmin.mode !== 'external' && isContainerRunning('vibedock-mongodb');
  if (useDocker) {
    runDockerExec(
      'vibedock-mongodb',
      ['mongosh', '--quiet', '-u', adminUser, '-p', adminPassword, '--authenticationDatabase', 'admin'],
      js,
    );
  } else {
    runClientCmd(
      'mongosh',
      ['--quiet', '--host', adminHost, '--port', String(port), '-u', adminUser, '-p', adminPassword, '--authenticationDatabase', 'admin'],
      { input: js, dockerImage: 'mongo:8.0' },
    );
  }
  const host = resolveTargetHost(cfg, adminHost, useDocker);
  return {
    type: 'mongodb',
    host,
    port,
    database: ident,
    username: ident,
    password,
    envKey: 'MONGODB_URI',
    url: `mongodb://${ident}:${urllibQuote(password)}@${host}:${port}/${ident}?authSource=${ident}`,
  };
}

function provisionRedis(cfg: VibeDockConfig, admin: Record<string, any>, project: string, ident: string, password: string): ProvisionedDbEntry {
  const rdAdmin = admin.redis || {};
  const adminHost = String(rdAdmin.host || '127.0.0.1').trim();
  const port = Number(rdAdmin.port || 6379);
  const adminPassword = String(rdAdmin.password || '');
  const prefix = `${project}:*`;
  const aclArgs = [
    '--no-auth-warning',
    ...(adminPassword ? ['-a', adminPassword] : []),
    'ACL', 'SETUSER', ident, 'on', `>${password}`, `~${prefix}`, '+@all', '-@dangerous',
  ];
  const useDocker = rdAdmin.mode !== 'external' && isContainerRunning('vibedock-redis');
  if (useDocker) {
    runDockerExec('vibedock-redis', ['redis-cli', ...aclArgs]);
  } else {
    runClientCmd('redis-cli', ['-h', adminHost, '-p', String(port), ...aclArgs], {
      dockerImage: 'redis:7.2-alpine',
    });
  }
  const host = resolveTargetHost(cfg, adminHost, useDocker);
  return {
    type: 'redis',
    host,
    port,
    database: '0',
    username: ident,
    password,
    keyPrefix: prefix,
    envKey: 'REDIS_URL',
    url: `redis://${ident}:${urllibQuote(password)}@${host}:${port}/0`,
  };
}

const ENV_KEYS: Record<string, string> = {
  postgresql: 'POSTGRES_URL',
  mysql: 'MYSQL_URL',
  mongodb: 'MONGODB_URI',
  redis: 'REDIS_URL',
};

const DEFAULT_PORTS: Record<string, number> = {
  postgresql: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
};

export function getDbStatus(cfg: VibeDockConfig) {
  const projectsDir = path.join(cfg.paths.dbSecretsDir, 'projects');
  const projects = fs.existsSync(projectsDir)
    ? fs.readdirSync(projectsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
    : [];
  const adminFile = path.join(cfg.paths.dbSecretsDir, 'admin.json');
  const admin = fs.existsSync(adminFile) ? JSON.parse(fs.readFileSync(adminFile, 'utf8')) : {};
  const instances: Record<string, { mode: string; host: string; port: number }> = {};
  for (const engine of SUPPORTED_TYPES) {
    const info = admin[engine] || {};
    instances[engine] = {
      mode: info.mode || 'docker',
      host: info.host || '127.0.0.1',
      port: Number(info.port || DEFAULT_PORTS[engine]),
    };
  }
  return {
    host: cfg.serverHost,
    mode: cfg.databases.mode,
    instances,
    projects,
  };
}

export function registerDbInstance(
  cfg: VibeDockConfig,
  rawEngine: string,
  options: { mode?: 'docker' | 'external'; host?: string; port?: number; user?: string; password?: string; url?: string },
) {
  const engine = String(rawEngine || '').trim().toLowerCase();
  const normalizedEngine = engine === 'postgres' || engine === 'pg' ? 'postgresql' : engine;
  if (!SUPPORTED_TYPES.has(normalizedEngine)) {
    throw new Error(`Unsupported database type: ${rawEngine} (use postgresql, mysql, mongodb, or redis)`);
  }
  fs.mkdirSync(cfg.paths.dbSecretsDir, { recursive: true, mode: 0o700 });
  const adminFile = path.join(cfg.paths.dbSecretsDir, 'admin.json');
  const admin = fs.existsSync(adminFile) ? JSON.parse(fs.readFileSync(adminFile, 'utf8')) : {};
  const current = admin[normalizedEngine] || {};

  let host = options.host || current.host || '127.0.0.1';
  let port = Number(options.port || current.port || DEFAULT_PORTS[normalizedEngine]);
  let user = options.user ?? current.user ?? (normalizedEngine === 'postgresql' ? 'postgres' : normalizedEngine === 'mysql' ? 'root' : 'admin');
  let password = options.password ?? current.password ?? '';

  if (options.url) {
    const parsed = new URL(options.url);
    host = parsed.hostname || host;
    port = Number(parsed.port || port);
    if (parsed.username) user = decodeURIComponent(parsed.username);
    if (parsed.password) password = decodeURIComponent(parsed.password);
  }

  const mode = options.mode || 'external';
  admin[normalizedEngine] = {
    mode,
    host,
    port,
    ...(normalizedEngine === 'redis' ? {} : { user }),
    password,
  };
  writeFileAtomic(adminFile, `${JSON.stringify(admin, null, 2)}\n`, 0o600);
  return {
    engine: normalizedEngine,
    mode,
    host,
    port,
    user: normalizedEngine === 'redis' ? undefined : user,
  };
}

export function bindProjectDbs(
  cfg: VibeDockConfig,
  rawProject: string,
  bindings: Record<string, string>,
) {
  const project = normalizeProject(rawProject);
  const entries = Object.entries(bindings).filter(([, v]) => Boolean(v && String(v).trim()));
  if (!entries.length) {
    throw new Error('Specify at least one database connection URL to bind');
  }
  const projectsDir = path.join(cfg.paths.dbSecretsDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(cfg.paths.dbSecretsDir, 'provision.lock');
  return withFileLock(lockFile, () => {
    const projFile = path.join(projectsDir, `${project}.json`);
    const record: { project: string; updatedAt: string; databases: Record<string, ProvisionedDbEntry> } = fs.existsSync(projFile)
      ? JSON.parse(fs.readFileSync(projFile, 'utf8'))
      : { project, updatedAt: '', databases: {} };

    for (const [rawKey, rawUrl] of entries) {
      const k = rawKey.trim().toLowerCase();
      const engine = k === 'postgres' || k === 'pg' ? 'postgresql' : k;
      if (!SUPPORTED_TYPES.has(engine)) {
        throw new Error(`Unsupported database type: ${rawKey}`);
      }
      const urlStr = String(rawUrl).trim();
      const parsed = new URL(urlStr);
      const dbName = parsed.pathname.replace(/^\/+/, '') || (engine === 'redis' ? '0' : project);
      record.databases[engine] = {
        type: engine,
        host: parsed.hostname || '127.0.0.1',
        port: Number(parsed.port || DEFAULT_PORTS[engine]),
        database: dbName,
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        envKey: ENV_KEYS[engine],
        url: urlStr,
        bound: true,
        ...(engine === 'redis' ? { keyPrefix: `${project}:*` } : {}),
      };
    }

    record.updatedAt = new Date().toISOString();
    writeFileAtomic(projFile, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    return record;
  });
}

export function getProjectDbRecord(cfg: VibeDockConfig, rawProject: string) {
  const project = normalizeProject(rawProject);
  const projFile = path.join(cfg.paths.dbSecretsDir, 'projects', `${project}.json`);
  if (!fs.existsSync(projFile)) {
    throw new Error(`No databases provisioned for project "${project}" yet`);
  }
  return JSON.parse(fs.readFileSync(projFile, 'utf8'));
}

export function provisionProjectDbs(cfg: VibeDockConfig, rawProject: string, rawTypes: string[]) {
  const project = normalizeProject(rawProject);
  const rawList = rawTypes.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const types = rawList.includes('all') ? [...SUPPORTED_TYPES] : rawList;
  if (!types.length) throw new Error('Specify at least one database type');
  for (const t of types) {
    if (!SUPPORTED_TYPES.has(t)) throw new Error(`Unsupported database type: ${t}`);
  }

  const admin = loadAdminCreds(cfg);
  const projectsDir = path.join(cfg.paths.dbSecretsDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(cfg.paths.dbSecretsDir, 'provision.lock');
  return withFileLock(lockFile, () => {
    const projFile = path.join(projectsDir, `${project}.json`);
    const record: { project: string; updatedAt: string; databases: Record<string, ProvisionedDbEntry> } = fs.existsSync(projFile)
      ? JSON.parse(fs.readFileSync(projFile, 'utf8'))
      : { project, updatedAt: '', databases: {} };

    const ident = safeIdentifier(project);
    for (const t of types) {
      const existing = record.databases?.[t];
      if (existing?.bound) {
        continue;
      }
      const existingPwd = existing?.password;
      const password =
        existingPwd && /^[A-Za-z0-9_-]{8,64}$/.test(existingPwd) ? existingPwd : randomSecret(24);
      if (t === 'postgresql') record.databases[t] = provisionPostgresql(cfg, admin, ident, password);
      else if (t === 'mysql') record.databases[t] = provisionMysql(cfg, admin, ident, password);
      else if (t === 'mongodb') record.databases[t] = provisionMongodb(cfg, admin, ident, password);
      else if (t === 'redis') record.databases[t] = provisionRedis(cfg, admin, project, ident, password);
    }

    record.updatedAt = new Date().toISOString();
    writeFileAtomic(projFile, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    return record;
  });
}

export function formatDbEnv(record: { databases?: Record<string, ProvisionedDbEntry> }): string {
  const lines: string[] = [];
  for (const entry of Object.values(record.databases || {})) {
    if (entry?.envKey && entry?.url) {
      lines.push(`${entry.envKey}=${JSON.stringify(entry.url)}`);
    }
    if (entry?.type === 'redis' && entry?.keyPrefix) {
      lines.push(`REDIS_KEY_PREFIX=${JSON.stringify(entry.keyPrefix)}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function verifyProjectDbRecord(cfg: VibeDockConfig, rawProject: string) {
  const record = getProjectDbRecord(cfg, rawProject);
  const checks: Record<string, { ok: boolean; envKey: string }> = {};
  for (const [key, entry] of Object.entries(record.databases || {}) as Array<[string, ProvisionedDbEntry]>) {
    checks[key] = { ok: Boolean(entry?.url), envKey: entry?.envKey || '' };
  }
  return { project: record.project, checks };
}

export function backupProjectDbs(
  cfg: VibeDockConfig,
  options: {
    project?: string;
    keepDays?: number;
    dumper?: (project: string, engine: string, entry: ProvisionedDbEntry) => string | Buffer;
  } = {},
) {
  const projectsDir = path.join(cfg.paths.dbSecretsDir, 'projects');
  const backupsRoot = path.join(cfg.paths.dataDir, 'backups', 'databases');
  fs.mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupsRoot, timestamp);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  let admin: Record<string, any> = {};
  try {
    admin = loadAdminCreds(cfg);
  } catch {
    // Allow backup of bound project records even if admin.json does not exist yet
  }

  const projectFiles = options.project
    ? [`${normalizeProject(options.project)}.json`]
    : fs.existsSync(projectsDir)
      ? fs.readdirSync(projectsDir).filter((f) => f.endsWith('.json')).sort()
      : [];

  const files: string[] = [];
  const errors: Array<{ project: string; engine: string; error: string }> = [];

  for (const file of projectFiles) {
    const fullPath = path.join(projectsDir, file);
    if (!fs.existsSync(fullPath)) continue;
    const record = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const proj = String(record.project || file.replace(/\.json$/, ''));
    for (const [engine, entry] of Object.entries(record.databases || {}) as Array<[string, ProvisionedDbEntry]>) {
      if (!entry) continue;
      try {
        let dumpContent: string | Buffer = '';
        let ext = 'sql';
        if (options.dumper) {
          dumpContent = options.dumper(proj, engine, entry);
          ext = engine === 'mongodb' ? 'archive' : engine === 'redis' ? 'json' : 'sql';
        } else if (engine === 'postgresql') {
          const pgAdmin = admin.postgresql || {};
          const useDocker = !entry.bound && pgAdmin.mode !== 'external' && isContainerRunning('vibedock-postgres');
          dumpContent = useDocker
            ? runDockerExec('vibedock-postgres', ['pg_dump', '-U', pgAdmin.user || 'postgres', entry.database])
            : runClientCmd(
                'pg_dump',
                ['-h', entry.host, '-p', String(entry.port), '-U', entry.username || pgAdmin.user || 'postgres', entry.database],
                { env: { PGPASSWORD: entry.password || pgAdmin.password || '' }, dockerImage: 'postgres:16-alpine' },
              );
        } else if (engine === 'mysql') {
          const myAdmin = admin.mysql || {};
          const useDocker = !entry.bound && myAdmin.mode !== 'external' && isContainerRunning('vibedock-mysql');
          dumpContent = useDocker
            ? runDockerExec('vibedock-mysql', [
                'mysqldump',
                '-u',
                myAdmin.user || 'root',
                `-p${myAdmin.password || ''}`,
                '--single-transaction',
                entry.database,
              ])
            : runClientCmd(
                'mysqldump',
                ['-h', entry.host, '-P', String(entry.port), '-u', entry.username || myAdmin.user || 'root', '--single-transaction', entry.database],
                { env: { MYSQL_PWD: entry.password || myAdmin.password || '' }, dockerImage: 'mysql:8.0' },
              );
        } else if (engine === 'mongodb') {
          ext = 'archive';
          const mgAdmin = admin.mongodb || {};
          const useDocker = !entry.bound && mgAdmin.mode !== 'external' && isContainerRunning('vibedock-mongodb');
          dumpContent = useDocker
            ? runDockerExecBuffer('vibedock-mongodb', ['mongodump', `--uri=${entry.url}`, '--archive', '--quiet'])
            : runClientCmdBuffer('mongodump', [`--uri=${entry.url}`, '--archive', '--quiet'], { dockerImage: 'mongo:8.0' });
        } else if (engine === 'redis') {
          ext = 'json';
          const rdAdmin = admin.redis || {};
          const useDocker = !entry.bound && rdAdmin.mode !== 'external' && isContainerRunning('vibedock-redis');
          const keyPattern = entry.keyPrefix || `${proj}:*`;
          const luaScript = [
            'local cursor = "0"',
            'local pattern = ARGV[1]',
            'local items = {}',
            'repeat',
            '  local res = redis.call("SCAN", cursor, "MATCH", pattern, "COUNT", 500)',
            '  cursor = res[1]',
            '  for _, k in ipairs(res[2]) do',
            '    local pttl = redis.call("PTTL", k)',
            '    if pttl < 0 then pttl = 0 end',
            '    local raw = redis.call("DUMP", k)',
            '    if raw then',
            '      local hex = string.gsub(raw, ".", function(c) return string.format("%02x", string.byte(c)) end)',
            '      table.insert(items, { key = k, pttl = pttl, dumpHex = hex })',
            '    end',
            '  end',
            'until cursor == "0"',
            'return cjson.encode(items)',
          ].join('\n');
          const dbIndexArg =
            entry.database !== undefined && /^\d+$/.test(String(entry.database).trim())
              ? ['-n', String(entry.database).trim()]
              : [];
          const rawJson = useDocker
            ? runDockerExec('vibedock-redis', [
                'redis-cli',
                '--no-auth-warning',
                ...dbIndexArg,
                ...(rdAdmin.password ? ['-a', rdAdmin.password] : []),
                '--raw',
                'EVAL',
                luaScript,
                '0',
                keyPattern,
              ])
            : runClientCmd(
                'redis-cli',
                [
                  '--no-auth-warning',
                  '-h',
                  entry.host || rdAdmin.host || '127.0.0.1',
                  '-p',
                  String(entry.port || rdAdmin.port || 6379),
                  ...dbIndexArg,
                  ...(entry.username && entry.username !== 'default' ? ['--user', entry.username] : []),
                  ...(entry.password || rdAdmin.password ? ['-a', entry.password || rdAdmin.password] : []),
                  '--raw',
                  'EVAL',
                  luaScript,
                  '0',
                  keyPattern,
                ],
                { dockerImage: 'redis:7.2-alpine' },
              );
          const parsedKeys = JSON.parse((rawJson || '[]').trim() || '[]');
          const keys = Array.isArray(parsedKeys) ? parsedKeys : [];
          dumpContent = `${JSON.stringify(
            { project: proj, engine: 'redis', keyPrefix: keyPattern, backedUpAt: now.toISOString(), keys },
            null,
            2,
          )}\n`;
        }
        const outFile = path.join(backupDir, `${proj}-${engine}.${ext}`);
        writeFileAtomic(outFile, dumpContent, 0o600);
        files.push(outFile);
      } catch (err: any) {
        errors.push({ project: proj, engine, error: err?.message || String(err) });
      }
    }
  }

  const manifestFile = path.join(backupDir, 'manifest.json');
  writeFileAtomic(
    manifestFile,
    `${JSON.stringify({ timestamp, createdAt: now.toISOString(), files, errors }, null, 2)}\n`,
    0o600,
  );

  const keepDays = Number.isFinite(options.keepDays) ? Math.max(1, Number(options.keepDays)) : 7;
  const cutoffMs = now.getTime() - keepDays * 86_400_000;
  const prunedDirs: string[] = [];
  for (const name of fs.readdirSync(backupsRoot)) {
    const candidate = path.join(backupsRoot, name);
    if (candidate === backupDir) continue;
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory() && st.mtimeMs < cutoffMs) {
        fs.rmSync(candidate, { recursive: true, force: true });
        prunedDirs.push(candidate);
      }
    } catch {
      // Ignore concurrent deletion
    }
  }

  return {
    ok: errors.length === 0,
    backupDir,
    timestamp,
    files,
    prunedDirs,
    errors,
  };
}
