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

function runDockerExec(container: string, args: string[], inputText?: string) {
  const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8', timeout: 5000 });
  if (inspect.status !== 0 || inspect.stdout.trim() !== 'true') {
    throw new Error(`Docker 数据库容器 ${container} 未启动，请先执行 "npx vibedock db up"`);
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

function provisionPostgresql(cfg: VibeDockConfig, admin: Record<string, any>, ident: string, password: string): ProvisionedDbEntry {
  const pgAdmin = admin.postgresql || {};
  const adminUser = pgAdmin.user || 'postgres';
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
  runDockerExec('vibedock-postgres', ['psql', '-v', 'ON_ERROR_STOP=1', '-U', adminUser, '-d', 'postgres'], sql);
  runDockerExec('vibedock-postgres', ['psql', '-v', 'ON_ERROR_STOP=1', '-U', adminUser, '-d', ident], `GRANT ALL ON SCHEMA public TO ${ident};\n`);
  const port = Number(pgAdmin.port || 5432);
  const host = cfg.serverHost;
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
  const sql = `
CREATE DATABASE IF NOT EXISTS \`${ident}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${ident}'@'%' IDENTIFIED BY '${password}';
ALTER USER '${ident}'@'%' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON \`${ident}\`.* TO '${ident}'@'%';
FLUSH PRIVILEGES;
`;
  runDockerExec('vibedock-mysql', ['mysql', '-uroot', `-p${myAdmin.password || ''}`], sql);
  const port = Number(myAdmin.port || 3306);
  const host = cfg.serverHost;
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
  runDockerExec(
    'vibedock-mongodb',
    ['mongosh', '--quiet', '-u', mgAdmin.user || 'admin', '-p', mgAdmin.password || '', '--authenticationDatabase', 'admin'],
    js,
  );
  const port = Number(mgAdmin.port || 27017);
  const host = cfg.serverHost;
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
  const prefix = `${project}:*`;
  runDockerExec('vibedock-redis', [
    'redis-cli', '--no-auth-warning', '-a', rdAdmin.password || '',
    'ACL', 'SETUSER', ident, 'on', `>${password}`, `~${prefix}`, '+@all', '-@dangerous',
  ]);
  const port = Number(rdAdmin.port || 6379);
  const host = cfg.serverHost;
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

export function getDbStatus(cfg: VibeDockConfig) {
  const projectsDir = path.join(cfg.paths.dbSecretsDir, 'projects');
  const projects = fs.existsSync(projectsDir)
    ? fs.readdirSync(projectsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
    : [];
  return {
    host: cfg.serverHost,
    mode: cfg.databases.mode,
    projects,
  };
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
      const existingPwd = record.databases?.[t]?.password;
      const password = existingPwd || randomSecret(24);
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
