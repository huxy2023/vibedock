#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadVibeDockConfig, PROJECT_ROOT, resolveStateRoot } from '../config.js';
import { createAuthService } from '../services/auth.js';
import {
  backupProjectDbs,
  bindProjectDbs,
  formatDbEnv,
  getDbStatus,
  getProjectDbRecord,
  provisionProjectDbs,
  registerDbInstance,
} from '../deploy/databases.js';
import { allocateAppSlot, publishApp, unpublishApp } from '../deploy/publish.js';
import { buildCaddyConfig, buildNginxConfig } from '../deploy/caddy.js';
import type { DatabaseEngine, GatewayStrategy, PublishManifest, VibeDockConfig } from '../types.js';

const DEFAULT_DB_PORTS: Record<DatabaseEngine, number> = {
  postgresql: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
};

const DEDICATED_DB_PORTS: Record<DatabaseEngine, number> = {
  postgresql: 45432,
  mysql: 43306,
  mongodb: 47017,
  redis: 46379,
};

const VIBEDOCK_DB_CONTAINERS: Record<DatabaseEngine, string> = {
  postgresql: 'vibedock-postgres',
  mysql: 'vibedock-mysql',
  mongodb: 'vibedock-mongodb',
  redis: 'vibedock-redis',
};

interface ParsedFlags {
  _: string[];
  [key: string]: string | boolean | string[];
}

function randomToken(len = 24): string {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function probePortListening(port: number, host = '127.0.0.1', timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function getRunningVibeDockDbContainers(): Set<string> {
  const res = spawnSync('docker', ['ps', '--filter', 'name=^/vibedock-', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout) return new Set();
  return new Set(
    res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

interface HostInfrastructureProbe {
  port80InUse: boolean;
  existingGateway: 'nginx' | 'caddy' | 'other' | 'none';
  occupiedDbs: Partial<Record<DatabaseEngine, boolean>>;
}

async function probeHostInfrastructure(enabledDbs: string[]): Promise<HostInfrastructureProbe> {
  const port80InUse = await probePortListening(80, '127.0.0.1');
  let existingGateway: 'nginx' | 'caddy' | 'other' | 'none' = 'none';
  if (process.platform === 'linux') {
    const nginxActive = spawnSync('systemctl', ['is-active', '--quiet', 'nginx']).status === 0;
    const caddyActive = spawnSync('systemctl', ['is-active', '--quiet', 'caddy']).status === 0;
    if (nginxActive) existingGateway = 'nginx';
    else if (caddyActive) existingGateway = 'caddy';
    else if (port80InUse) existingGateway = 'other';
  } else if (port80InUse) {
    existingGateway = 'other';
  }

  const runningContainers = getRunningVibeDockDbContainers();
  const occupiedDbs: Partial<Record<DatabaseEngine, boolean>> = {};
  for (const raw of enabledDbs) {
    const eng = raw as DatabaseEngine;
    const defaultPort = DEFAULT_DB_PORTS[eng];
    if (!defaultPort) continue;
    const containerName = VIBEDOCK_DB_CONTAINERS[eng];
    if (runningContainers.has(containerName)) {
      occupiedDbs[eng] = false;
      continue;
    }
    occupiedDbs[eng] = await probePortListening(defaultPort, '127.0.0.1');
  }

  return { port80InUse, existingGateway, occupiedDbs };
}

function ensureDbSecrets(
  cfg: VibeDockConfig,
  options?: {
    dbStrategy?: 'dedicated' | 'reuse';
    occupiedDbs?: Partial<Record<DatabaseEngine, boolean>>;
  },
) {
  const secretDir = cfg.paths.dbSecretsDir;
  fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(secretDir), 0o700);
    fs.chmodSync(secretDir, 0o700);
  } catch {
    // Non-fatal
  }
  const adminFile = path.join(secretDir, 'admin.json');
  let adminData: Record<string, any>;
  if (fs.existsSync(adminFile)) {
    adminData = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
  } else {
    adminData = {
      postgresql: { host: '127.0.0.1', port: 5432, user: 'postgres', password: randomToken(28), mode: 'docker' },
      mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: randomToken(28), mode: 'docker' },
      mongodb: { host: '127.0.0.1', port: 27017, user: 'admin', password: randomToken(28), mode: 'docker' },
      redis: { host: '127.0.0.1', port: 6379, password: randomToken(28), mode: 'docker' },
    };
  }

  let updatedAdmin = !fs.existsSync(adminFile);
  if (options?.dbStrategy && options.occupiedDbs) {
    for (const [eng, isOccupied] of Object.entries(options.occupiedDbs) as Array<[DatabaseEngine, boolean]>) {
      if (!isOccupied || !adminData[eng]) continue;
      if (options.dbStrategy === 'dedicated') {
        adminData[eng].port = DEDICATED_DB_PORTS[eng];
        adminData[eng].mode = 'docker';
        updatedAdmin = true;
      } else if (options.dbStrategy === 'reuse') {
        adminData[eng].port = DEFAULT_DB_PORTS[eng];
        adminData[eng].mode = 'external';
        updatedAdmin = true;
      }
    }
  }
  if (updatedAdmin) {
    fs.writeFileSync(adminFile, `${JSON.stringify(adminData, null, 2)}\n`, { mode: 0o600 });
  }

  const dbDataDir = path.join(cfg.paths.dataDir, 'databases');
  fs.mkdirSync(dbDataDir, { recursive: true });
  const dbEnvFile = path.join(dbDataDir, '.env.db');
  const envContent = [
    '# Auto-generated by VibeDock CLI',
    `VIBEDOCK_DB_DATA_DIR=${dbDataDir}`,
    'VIBEDOCK_PG_BIND=127.0.0.1',
    `VIBEDOCK_PG_PORT=${adminData.postgresql?.port || 5432}`,
    `VIBEDOCK_PG_USER=${adminData.postgresql?.user || 'postgres'}`,
    `VIBEDOCK_PG_PASSWORD=${adminData.postgresql?.password || ''}`,
    'VIBEDOCK_MYSQL_BIND=127.0.0.1',
    `VIBEDOCK_MYSQL_PORT=${adminData.mysql?.port || 3306}`,
    `VIBEDOCK_MYSQL_PASSWORD=${adminData.mysql?.password || ''}`,
    'VIBEDOCK_MONGO_BIND=127.0.0.1',
    `VIBEDOCK_MONGO_PORT=${adminData.mongodb?.port || 27017}`,
    `VIBEDOCK_MONGO_USER=${adminData.mongodb?.user || 'admin'}`,
    `VIBEDOCK_MONGO_PASSWORD=${adminData.mongodb?.password || ''}`,
    'VIBEDOCK_REDIS_BIND=127.0.0.1',
    `VIBEDOCK_REDIS_PORT=${adminData.redis?.port || 6379}`,
    `VIBEDOCK_REDIS_PASSWORD=${adminData.redis?.password || ''}`,
    '',
  ].join('\n');
  fs.writeFileSync(dbEnvFile, envContent, { mode: 0o600 });
  return { adminFile, dbEnvFile, adminData };
}

function ensureDeployKeypair(cfg: VibeDockConfig) {
  const keysDir = path.join(cfg.paths.dataDir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(keysDir, 'deploy_key');
  const pubFile = `${keyFile}.pub`;
  if (!fs.existsSync(keyFile)) {
    execFileSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', `${cfg.deployUser}@${cfg.brandName.toLowerCase()}`, '-f', keyFile],
      { stdio: 'ignore' },
    );
    fs.chmodSync(keyFile, 0o600);
  }
  return { keyFile, pubFile };
}

function replacePlaceholders(content: string, vars: Record<string, string | number>): string {
  return content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

export function packSkill(cfg: VibeDockConfig) {
  const { keyFile } = ensureDeployKeypair(cfg);
  const skillName = cfg.skillName || 'vibedock-deploy';
  const distRoot = path.join(cfg.paths.dataDir, 'skill-dist');
  const targetDir = path.join(distRoot, skillName);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(targetDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'references'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'access'), { recursive: true, mode: 0o700 });

  const vars = {
    SKILL_NAME: skillName,
    BRAND_NAME: cfg.brandName,
    SERVER_HOST: cfg.serverHost,
    PRIMARY_DOMAIN: cfg.primaryDomain,
    BACKUP_DOMAIN: cfg.backupDomain || '',
    PORTAL_URL: cfg.portalUrl,
    APPS_DIR: cfg.paths.appsDir,
    APP_PREFIX: cfg.appPrefix,
    PORT_START: cfg.portRange.start,
    PORT_END: cfg.portRange.end,
  };

  const tplDir = path.join(PROJECT_ROOT, 'skill-template');
  for (const rel of ['SKILL.md', 'references/deploy.md', 'references/database.md']) {
    const raw = fs.readFileSync(path.join(tplDir, rel), 'utf8');
    fs.writeFileSync(path.join(targetDir, rel), replacePlaceholders(raw, vars), 'utf8');
  }

  const compiledClientPath = path.join(PROJECT_ROOT, 'dist', 'skill', 'client.js');
  const targetClientPath = path.join(targetDir, 'scripts', 'client.mjs');
  fs.copyFileSync(compiledClientPath, targetClientPath);
  fs.chmodSync(targetClientPath, 0o755);

  fs.copyFileSync(keyFile, path.join(targetDir, 'access/deploy_key'));
  fs.chmodSync(path.join(targetDir, 'access/deploy_key'), 0o600);
  fs.writeFileSync(path.join(targetDir, 'access/known_hosts'), '', { mode: 0o600 });

  let deployToken = cfg.deployToken || '';
  if (!deployToken) {
    deployToken = `vd_${crypto.randomBytes(24).toString('hex')}`;
    cfg.deployToken = deployToken;
    if (cfg.configPath && fs.existsSync(cfg.configPath)) {
      try {
        const rawCfg = JSON.parse(fs.readFileSync(cfg.configPath, 'utf8'));
        rawCfg.deployToken = deployToken;
        fs.writeFileSync(cfg.configPath, `${JSON.stringify(rawCfg, null, 2)}\n`, { mode: 0o600 });
      } catch {
        // Non-fatal
      }
    }
  }

  const serverJson = {
    brandName: cfg.brandName,
    skillName,
    serverHost: cfg.serverHost,
    sshPort: cfg.sshPort,
    deployUser: cfg.deployUser,
    appPrefix: cfg.appPrefix,
    appsDir: cfg.paths.appsDir,
    portalUrl: cfg.portalUrl,
    mcpUrl: `${cfg.portalUrl.replace(/\/+$/, '')}/api/mcp`,
    deployToken,
    publishCommand: 'sudo -n /usr/local/bin/vibedock-publish',
    dbCommand: 'sudo -n /usr/local/bin/vibedock-db-provision',
  };
  fs.writeFileSync(path.join(targetDir, 'access/server.json'), `${JSON.stringify(serverJson, null, 2)}\n`, 'utf8');

  const zipPath = cfg.paths.skillZipFile;
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.rmSync(zipPath, { force: true });
  execFileSync('zip', ['-r', '-q', zipPath, skillName], { cwd: distRoot });
  fs.chmodSync(zipPath, 0o600);
  fs.rmSync(distRoot, { recursive: true, force: true });
  return { zipPath, targetDir };
}

function syncCatalogEnvironment(cfg: VibeDockConfig): void {
  const catalogPath = path.join(cfg.paths.dataDir, 'catalog.json');
  if (!fs.existsSync(catalogPath)) return;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const isDedicatedChain = cfg.gatewayStrategy === 'dedicated-chain';
    const hasCustomTls =
      !isDedicatedChain &&
      cfg.domainMode === 'custom' &&
      Boolean(cfg.tls?.certFile && cfg.tls?.keyFile);
    const scheme =
      cfg.domainMode === 'nip' || isDedicatedChain || (cfg.gateway === 'nginx' && !hasCustomTls) ? 'http' : 'https';
    catalog.environment = {
      ...(catalog.environment || {}),
      name: `${cfg.brandName} Server`,
      brandName: cfg.brandName,
      skillName: cfg.skillName,
      address: cfg.serverHost,
      domainSuffix: cfg.primaryDomain,
      backupDomainSuffix: cfg.backupDomain || '',
      gatewayPort: cfg.gatewayStrategy === 'dedicated-port' ? cfg.gatewayHttpPort || 8080 : 80,
      gatewayTlsPort: cfg.gatewayStrategy === 'dedicated-port' ? cfg.gatewayHttpsPort || 8443 : 443,
    };
    if (Array.isArray(catalog.projects)) {
      for (const proj of catalog.projects) {
        if (!Array.isArray(proj.ingressRules)) continue;
        const nextHost =
          proj.id === 'vibedock-portal' ? `portal.${cfg.primaryDomain}` : `${proj.id}.${cfg.primaryDomain}`;
        for (const r of proj.ingressRules) {
          if (r.match) {
            r.match.scheme = scheme;
            r.match.hosts = [nextHost];
          }
          if (hasCustomTls) {
            r.tls = { certificateFile: cfg.tls!.certFile, keyFile: cfg.tls!.keyFile };
          } else {
            delete r.tls;
          }
        }
        const siteFile = path.join(cfg.paths.caddySitesDir, `${proj.id}.caddy`);
        if (proj.id !== 'vibedock-portal' && (fs.existsSync(siteFile) || cfg.gateway === 'caddy')) {
          fs.mkdirSync(cfg.paths.caddySitesDir, { recursive: true, mode: 0o755 });
          fs.writeFileSync(siteFile, `# Managed by VibeDock (${proj.id})\n${buildCaddyConfig(proj)}\n`, 'utf8');
        }
        const nginxSitesDir = cfg.paths.nginxSitesDir || path.join(cfg.paths.dataDir, 'nginx/sites');
        const nginxFile = path.join(nginxSitesDir, `${proj.id}.conf`);
        if (proj.id !== 'vibedock-portal' && (fs.existsSync(nginxFile) || cfg.gateway === 'nginx')) {
          fs.mkdirSync(nginxSitesDir, { recursive: true, mode: 0o755 });
          fs.writeFileSync(nginxFile, `# Managed by VibeDock (${proj.id})\n${buildNginxConfig(proj)}\n`, 'utf8');
        }
      }
    }
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  } catch {
    // Ignore if catalog is missing or invalid during bootstrap
  }
}

function isPrivateOrLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === 'localhost' ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.lan')
  );
}

function buildPortalCaddyBlock(cfg: VibeDockConfig): string {
  const isDedicatedChain = cfg.gatewayStrategy === 'dedicated-chain';
  const scheme = cfg.domainMode === 'nip' || isDedicatedChain ? 'http' : 'https';
  const hasCustomTls =
    !isDedicatedChain &&
    cfg.domainMode === 'custom' &&
    cfg.tls?.certFile &&
    cfg.tls?.keyFile &&
    /^\/[A-Za-z0-9._/-]+$/.test(cfg.tls.certFile) &&
    /^\/[A-Za-z0-9._/-]+$/.test(cfg.tls.keyFile);
  const lines = [
    '# Managed by VibeDock (Portal Reverse Proxy)',
    `${scheme}://portal.${cfg.primaryDomain}, ${scheme}://services.${cfg.primaryDomain} {`,
  ];
  if (hasCustomTls) {
    lines.push(`  tls ${cfg.tls!.certFile} ${cfg.tls!.keyFile}`);
  }
  lines.push('  reverse_proxy 127.0.0.1:39090', '}', '');
  return lines.join('\n');
}

function buildDedicatedCaddyMainConfig(cfg: VibeDockConfig): string {
  const httpPort = cfg.gatewayHttpPort || (cfg.gatewayStrategy === 'dedicated-port' ? 8080 : 39080);
  const httpsPort = cfg.gatewayHttpsPort || 8443;
  const globalLines = [
    '# Managed by VibeDock Dedicated Gateway',
    '{',
    '  admin 127.0.0.1:39081',
    `  http_port ${httpPort}`,
  ];
  if (cfg.gatewayStrategy === 'dedicated-chain') {
    globalLines.push('  default_bind 127.0.0.1', '  auto_https off');
  } else {
    globalLines.push(`  https_port ${httpsPort}`);
    if (cfg.domainMode === 'nip') {
      globalLines.push('  auto_https off');
    }
  }
  globalLines.push('}', '', `import ${cfg.paths.caddySitesDir}/*.caddy`, '');
  return globalLines.join('\n');
}

function buildUpstreamGatewaySnippet(cfg: VibeDockConfig): string {
  const httpPort = cfg.gatewayHttpPort || 39080;
  return [
    '# ============================================================================',
    '# VibeDock 双层串联网关 (Two-Tier Gateway Chaining) 一次性外层转发规则',
    `# 内部专用网关监听: http://127.0.0.1:${httpPort}`,
    '# 后续所有 VibeDock 应用发布/下线均只热重载内部专用网关，外层网关永久免改动！',
    '# ============================================================================',
    '',
    '# [方案 A] 如果外层是 Nginx，请将以下 server 块加入您的 Nginx 配置并执行一次 nginx -s reload:',
    'server {',
    '    listen 80;',
    `    server_name portal.${cfg.primaryDomain} services.${cfg.primaryDomain} *.${cfg.primaryDomain};`,
    '    location / {',
    `        proxy_pass http://127.0.0.1:${httpPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '    }',
    '}',
    '',
    '# [方案 B] 如果外层是 Caddy，请将以下站点块加入主 Caddyfile 并执行一次 caddy reload:',
    `# http://portal.${cfg.primaryDomain}, http://services.${cfg.primaryDomain}, http://*.${cfg.primaryDomain} {`,
    `#   reverse_proxy 127.0.0.1:${httpPort}`,
    '# }',
    '',
  ].join('\n');
}

function buildPortalNginxBlock(cfg: VibeDockConfig): string {
  const hasCustomTls =
    cfg.domainMode === 'custom' &&
    cfg.tls?.certFile &&
    cfg.tls?.keyFile &&
    /^\/[A-Za-z0-9._/-]+$/.test(cfg.tls.certFile) &&
    /^\/[A-Za-z0-9._/-]+$/.test(cfg.tls.keyFile);
  const lines = [
    '# Managed by VibeDock (Portal Reverse Proxy)',
    'server {',
    '    listen 80;',
  ];
  if (hasCustomTls) {
    lines.push(
      '    listen 443 ssl;',
      `    ssl_certificate ${cfg.tls!.certFile};`,
      `    ssl_certificate_key ${cfg.tls!.keyFile};`,
    );
  }
  lines.push(
    `    server_name portal.${cfg.primaryDomain} services.${cfg.primaryDomain};`,
    '    location / {',
    '        proxy_pass http://127.0.0.1:39090;',
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '    }',
    '}',
    '',
  );
  return lines.join('\n');
}

function detectActiveGateway(): 'caddy' | 'nginx' {
  if (process.platform === 'linux') {
    const nginxActive = spawnSync('systemctl', ['is-active', '--quiet', 'nginx']).status === 0;
    const caddyActive = spawnSync('systemctl', ['is-active', '--quiet', 'caddy']).status === 0;
    if (nginxActive && !caddyActive) return 'nginx';
  }
  return 'caddy';
}

function syncHostIntegrationIfReady(cfg: VibeDockConfig, pubFile?: string): void {
  if (process.platform !== 'linux') return;
  try {
    const sshDir = path.join(cfg.paths.dataDir, 'deploy', '.ssh');
    if (pubFile && fs.existsSync(sshDir) && fs.existsSync(pubFile)) {
      const authKeys = path.join(sshDir, 'authorized_keys');
      fs.copyFileSync(pubFile, authKeys);
      fs.chmodSync(authKeys, 0o600);
      spawnSync('chown', [`${cfg.deployUser}:${cfg.deployUser}`, authKeys]);
    }
    fs.mkdirSync(cfg.paths.appsDir, { recursive: true, mode: 0o755 });
    spawnSync('chown', [`${cfg.deployUser}:${cfg.deployUser}`, cfg.paths.appsDir]);
    const gateway = cfg.gateway || 'caddy';
    const strategy = cfg.gatewayStrategy || (gateway === 'none' ? 'none' : 'reuse');

    if (strategy === 'dedicated-chain' || strategy === 'dedicated-port') {
      fs.mkdirSync(path.dirname(cfg.paths.caddyConfig), { recursive: true, mode: 0o755 });
      fs.mkdirSync(cfg.paths.caddySitesDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(path.join(cfg.paths.caddySitesDir, '00-vibedock-portal.caddy'), buildPortalCaddyBlock(cfg), 'utf8');
      fs.writeFileSync(cfg.paths.caddyConfig, buildDedicatedCaddyMainConfig(cfg), 'utf8');
      if (strategy === 'dedicated-chain') {
        fs.writeFileSync(
          path.join(cfg.paths.dataDir, 'gateway-upstream-snippet.conf'),
          buildUpstreamGatewaySnippet(cfg),
          'utf8',
        );
      }
      if (fs.existsSync('/etc/nginx/conf.d/vibedock.conf')) {
        fs.rmSync('/etc/nginx/conf.d/vibedock.conf', { force: true });
        spawnSync(cfg.paths.nginxBin || 'nginx', ['-s', 'reload'], { stdio: 'ignore' });
      }
      if (fs.existsSync('/etc/systemd/system')) {
        const unitContent = [
          '[Unit]',
          'Description=VibeDock Dedicated Gateway (Caddy)',
          'After=network.target network-online.target',
          'Requires=network-online.target',
          '',
          '[Service]',
          'Type=notify',
          'User=root',
          'Group=root',
          `ExecStart=/usr/bin/caddy run --environ --config ${cfg.paths.caddyConfig}`,
          `ExecReload=/usr/bin/caddy reload --config ${cfg.paths.caddyConfig} --force`,
          'TimeoutStopSec=5s',
          'LimitNOFILE=1048576',
          'PrivateTmp=true',
          'Restart=on-failure',
          '',
          '[Install]',
          'WantedBy=multi-user.target',
          '',
        ].join('\n');
        fs.writeFileSync('/etc/systemd/system/vibedock-caddy.service', unitContent, 'utf8');
        spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
        spawnSync('systemctl', ['enable', '--now', 'vibedock-caddy'], { stdio: 'ignore' });
      }
      spawnSync(cfg.paths.caddyBin || 'caddy', ['reload', '--config', cfg.paths.caddyConfig], { stdio: 'ignore' });
    } else if (gateway === 'nginx') {
      if (fs.existsSync('/etc/systemd/system/vibedock-caddy.service')) {
        spawnSync('systemctl', ['disable', '--now', 'vibedock-caddy'], { stdio: 'ignore' });
      }
      const nginxSitesDir = cfg.paths.nginxSitesDir || path.join(cfg.paths.dataDir, 'nginx/sites');
      fs.mkdirSync(nginxSitesDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(path.join(nginxSitesDir, '00-vibedock-portal.conf'), buildPortalNginxBlock(cfg), 'utf8');
      if (fs.existsSync('/etc/nginx/conf.d')) {
        fs.writeFileSync('/etc/nginx/conf.d/vibedock.conf', `# Managed by VibeDock\ninclude ${nginxSitesDir}/*.conf;\n`, 'utf8');
      }
      if (fs.existsSync(cfg.paths.nginxConfig || '/etc/nginx/nginx.conf')) {
        spawnSync(cfg.paths.nginxBin || 'nginx', ['-s', 'reload'], { stdio: 'ignore' });
      }
    } else if (gateway === 'caddy') {
      if (fs.existsSync('/etc/systemd/system/vibedock-caddy.service')) {
        spawnSync('systemctl', ['disable', '--now', 'vibedock-caddy'], { stdio: 'ignore' });
      }
      fs.mkdirSync(cfg.paths.caddySitesDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(path.join(cfg.paths.caddySitesDir, '00-vibedock-portal.caddy'), buildPortalCaddyBlock(cfg), 'utf8');
      if (fs.existsSync(cfg.paths.caddyConfig)) {
        spawnSync(cfg.paths.caddyBin || 'caddy', ['reload', '--config', cfg.paths.caddyConfig], { stdio: 'ignore' });
      }
    }
  } catch {
    // Non-fatal if not running as root yet
  }
}

function detectPrimaryIpv4(): string {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

async function cmdInit(flags: ParsedFlags): Promise<void> {
  const nonInteractive = Boolean(flags.yes || flags.y);
  let brandName = String(flags.brand || 'VibeDock');
  let serverHost = String(flags.host || detectPrimaryIpv4());
  let primaryDomain = String(flags.domain || `${serverHost}.nip.io`);
  const tlsCert = flags['tls-cert'] ? String(flags['tls-cert']).trim() : '';
  const tlsKey = flags['tls-key'] ? String(flags['tls-key']).trim() : '';
  let domainMode = flags['domain-mode']
    ? String(flags['domain-mode'])
    : tlsCert && tlsKey
      ? 'custom'
      : primaryDomain.endsWith('.nip.io') || primaryDomain.endsWith('.local')
        ? 'nip'
        : 'letsencrypt';
  const backupDomain = String(flags['backup-domain'] || '');
  let enabledDbs = flags.dbs
    ? String(flags.dbs)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['postgresql', 'mysql', 'mongodb', 'redis'];

  const probe = await probeHostInfrastructure(enabledDbs);
  const occupiedDbList = Object.entries(probe.occupiedDbs)
    .filter(([, inUse]) => inUse)
    .map(([eng]) => `${eng}:${DEFAULT_DB_PORTS[eng as DatabaseEngine]}`);

  let gatewayStrategy: GatewayStrategy =
    flags['gateway-strategy'] === 'dedicated-chain' ||
    flags['gateway-strategy'] === 'dedicated-port' ||
    flags['gateway-strategy'] === 'none' ||
    flags['gateway-strategy'] === 'reuse'
      ? (flags['gateway-strategy'] as GatewayStrategy)
      : flags.gateway === 'none'
        ? 'none'
        : 'reuse';
  let gatewayHttpPort = flags['gateway-http-port'] ? Number(flags['gateway-http-port']) : undefined;
  let gatewayHttpsPort = flags['gateway-https-port'] ? Number(flags['gateway-https-port']) : undefined;
  let dbStrategy: 'dedicated' | 'reuse' =
    flags['db-strategy'] === 'reuse' ? 'reuse' : 'dedicated';

  if (!nonInteractive && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\n🚀 欢迎使用 VibeDock 初始化向导 (AI-Native 团队应用与数据库门户)\n');
    brandName = (await rl.question(`1. 门户品牌名称 [${brandName}]: `)).trim() || brandName;
    serverHost = (await rl.question(`2. 服务器 IP 或主机地址 [${serverHost}]: `)).trim() || serverHost;
    const defaultDomain = `${serverHost}.nip.io`;
    primaryDomain = (await rl.question(`3. 应用主域名后缀 (留空默认免 DNS 的 ${defaultDomain}): `)).trim() || defaultDomain;
    domainMode =
      tlsCert && tlsKey
        ? 'custom'
        : primaryDomain.endsWith('.nip.io') || primaryDomain.endsWith('.local')
          ? 'nip'
          : 'letsencrypt';
    const dbsAns = (await rl.question(`4. 启用的共享数据库 (逗号分隔) [${enabledDbs.join(',')}]: `)).trim();
    if (dbsAns) {
      enabledDbs = dbsAns
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!flags['gateway-strategy'] && !flags.gateway && probe.port80InUse) {
      console.log(`\n🔍 检测到本机 80 端口已有网关运行 (${probe.existingGateway})，请选择网关共存策略 (不替您做选择):`);
      console.log(`   [1] 复用已有网关 (reuse)          — 在现有 ${probe.existingGateway} 中通过 drop-in 目录动态挂载子域名`);
      console.log('   [2] 新建专用网关·双层串联 (chain) — 启动独立 VibeDock 专用网关 (127.0.0.1:39080)，原网关仅需配 1 条泛域名转发且后续永不改动');
      console.log('   [3] 新建专用网关·独立端口 (port)  — 启动独立 VibeDock 专用网关监听独立端口 (默认 8080/8443)，与 80/443 完全物理隔离');
      console.log('   [4] 无本机网关 (none)             — 仅管理应用进程，由外部负载均衡 / Tunnel 透传');
      const gwChoice = (await rl.question('   请选择网关策略 [1/2/3/4，默认 1]: ')).trim();
      if (gwChoice === '2' || gwChoice === 'chain' || gwChoice === 'dedicated-chain') {
        gatewayStrategy = 'dedicated-chain';
      } else if (gwChoice === '3' || gwChoice === 'port' || gwChoice === 'dedicated-port') {
        gatewayStrategy = 'dedicated-port';
        const pAns = (await rl.question('   请输入专用网关 HTTP 端口 [8080]: ')).trim();
        gatewayHttpPort = pAns ? Number(pAns) : 8080;
      } else if (gwChoice === '4' || gwChoice === 'none') {
        gatewayStrategy = 'none';
      } else {
        gatewayStrategy = 'reuse';
      }
    }

    if (!flags['db-strategy'] && occupiedDbList.length > 0) {
      console.log(`\n🔍 检测到本机默认数据库端口已被已有服务占用 (${occupiedDbList.join(', ')})，请选择数据库共存策略:`);
      console.log('   [1] 新建专用容器并自动避让端口 (dedicated) — 原数据库保持不动，VibeDock 专用容器自动改用 45432/43306/47017/46379 新旧并存');
      console.log('   [2] 复用本机已有数据库实例 (reuse)         — 不新建冲突容器，将占用引擎标记为 external 供 vibedock db register/bind 接入');
      const dbChoice = (await rl.question('   请选择数据库策略 [1/2，默认 1]: ')).trim();
      dbStrategy = dbChoice === '2' || dbChoice === 'reuse' ? 'reuse' : 'dedicated';
    }

    rl.close();
  }

  if (gatewayStrategy === 'dedicated-chain' && !gatewayHttpPort) {
    gatewayHttpPort = 39080;
  } else if (gatewayStrategy === 'dedicated-port') {
    if (!gatewayHttpPort) gatewayHttpPort = 8080;
    if (!gatewayHttpsPort) gatewayHttpsPort = 8443;
  }

  const adminPassword = String(flags['admin-password'] || `vd-${randomToken(10)}`);
  const inviteCode = String(flags['invite-code'] || `team-${randomToken(6).toLowerCase()}`);
  const gateway: 'caddy' | 'nginx' | 'none' =
    gatewayStrategy === 'none'
      ? 'none'
      : gatewayStrategy === 'dedicated-chain' || gatewayStrategy === 'dedicated-port'
        ? 'caddy'
        : flags.gateway === 'nginx' || flags.gateway === 'none' || flags.gateway === 'caddy'
          ? flags.gateway
          : detectActiveGateway();

  const stateRoot = resolveStateRoot();
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o755 });
  const isUnifiedStateRoot = stateRoot === '/var/lib/vibedock' || Boolean(process.env.VIBEDOCK_HOME);

  const portalScheme =
    domainMode === 'nip' || ((gateway === 'nginx' || gatewayStrategy === 'dedicated-chain') && !(tlsCert && tlsKey))
      ? 'http'
      : 'https';
  const portalPortSuffix =
    gatewayStrategy === 'dedicated-port'
      ? portalScheme === 'https'
        ? gatewayHttpsPort && gatewayHttpsPort !== 443
          ? `:${gatewayHttpsPort}`
          : ''
        : gatewayHttpPort && gatewayHttpPort !== 80
          ? `:${gatewayHttpPort}`
          : ''
      : '';
  const caddyConfigPath =
    gatewayStrategy === 'dedicated-chain' || gatewayStrategy === 'dedicated-port'
      ? path.join(stateRoot, 'caddy/Caddyfile')
      : '/etc/caddy/Caddyfile';

  const configData = {
    brandName,
    portalTitle: `${brandName} · 团队应用与开发者门户`,
    skillName: 'vibedock-deploy',
    serverHost,
    sshPort: 22,
    deployUser: 'vibe-deploy',
    appPrefix: 'team-',
    gateway,
    gatewayStrategy,
    gatewayHttpPort,
    gatewayHttpsPort,
    domainMode,
    primaryDomain,
    backupDomain,
    portalUrl: `${portalScheme}://portal.${primaryDomain}${portalPortSuffix}`,
    deployToken: `vd_${crypto.randomBytes(24).toString('hex')}`,
    tls: {
      certFile: tlsCert,
      keyFile: tlsKey,
    },
    portRange: { start: 40000, end: 40999 },
    paths: {
      dataDir: stateRoot,
      appsDir: path.join(stateRoot, 'apps'),
      caddyBin: 'caddy',
      caddyConfig: caddyConfigPath,
      caddySitesDir: path.join(stateRoot, 'caddy/sites'),
      nginxBin: 'nginx',
      nginxConfig: '/etc/nginx/nginx.conf',
      nginxSitesDir: path.join(stateRoot, 'nginx/sites'),
      dbSecretsDir: path.join(stateRoot, 'secrets/databases'),
      skillZipFile: path.join(stateRoot, 'vibedock-deploy.zip'),
    },
    databases: {
      mode: 'docker',
      composeFile: path.join(PROJECT_ROOT, 'docker/docker-compose.db.yml'),
      enabled: enabledDbs,
    },
    auth: {
      defaultAdminUser: 'admin',
      defaultAdminDisplayName: '系统管理员',
      defaultAdminPassword: adminPassword,
      defaultMemberPassword: inviteCode,
      defaultInviteCode: inviteCode,
    },
  };

  const configPath = isUnifiedStateRoot
    ? path.join(stateRoot, 'vibedock.config.json')
    : path.join(PROJECT_ROOT, 'vibedock.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configData, null, 2)}\n`, { mode: 0o600 });

  const cfg = loadVibeDockConfig(configPath);
  const { adminFile, adminData } = ensureDbSecrets(cfg, {
    dbStrategy,
    occupiedDbs: probe.occupiedDbs,
  });
  const { pubFile } = ensureDeployKeypair(cfg);
  syncCatalogEnvironment(cfg);
  const { zipPath } = packSkill(cfg);
  syncHostIntegrationIfReady(cfg, pubFile);
  const authSvc = createAuthService({
    databaseFile: path.join(cfg.paths.dataDir, 'vibedock-auth.sqlite3'),
    defaultAdminUser: cfg.auth.defaultAdminUser,
    defaultAdminDisplayName: cfg.auth.defaultAdminDisplayName,
    defaultAdminPassword: cfg.auth.defaultAdminPassword,
    defaultMemberPassword: cfg.auth.defaultMemberPassword,
    defaultInviteCode: cfg.auth.defaultInviteCode,
  });
  authSvc.updateInviteCode(inviteCode);
  const adminUser = authSvc.listUsers().users.find((u) => u.username === cfg.auth.defaultAdminUser);
  if (adminUser && adminPassword.length >= 8) {
    authSvc.updateUser(String(adminUser.id), { password: adminPassword });
  }
  authSvc.close();

  console.log('\n✅ VibeDock 初始化完成！');
  console.log(`   - 配置文件:       ${configPath}`);
  console.log(`   - 网关共存策略:   ${gatewayStrategy} (gateway=${gateway}${gatewayHttpPort ? `, httpPort=${gatewayHttpPort}` : ''})`);
  if (gatewayStrategy === 'dedicated-chain') {
    console.log(`   - 外层转发片段:   ${path.join(stateRoot, 'gateway-upstream-snippet.conf')} (仅需在外层网关配置一次泛域名转发)`);
  }
  if (occupiedDbList.length > 0) {
    const dbSummary = enabledDbs
      .map((e) => `${e}->${adminData[e]?.mode || 'docker'}:${adminData[e]?.port}`)
      .join(', ');
    console.log(`   - 数据库共存策略: ${dbStrategy} (${dbSummary})`);
  }
  console.log(`   - 数据库主凭据:   ${adminFile}`);
  console.log(`   - 部署公钥:       ${pubFile}`);
  console.log(`   - 已烘焙 Skill:   ${zipPath}`);
  console.log(`   - 管理员初始账号: admin / ${adminPassword}`);
  console.log(`   - 团队注册邀请码: ${inviteCode}`);
  console.log(`   - 下载 Skill 命令: curl -fsSL "${cfg.portalUrl}/api/dx/skill-package?code=${inviteCode}" -o vibedock-deploy.zip`);

  if (!primaryDomain.endsWith('.nip.io') && !primaryDomain.endsWith('.local')) {
    console.log('\n🌐 域名与 DNS 泛解析引导:');
    console.log(`   请确认已在域名 DNS 控制台添加以下 2 条 A 记录指向 ${serverHost}:`);
    console.log(`   - 主机记录: portal  -> 记录值: ${serverHost}  (用于门户 portal.${primaryDomain})`);
    console.log(`   - 主机记录: *       -> 记录值: ${serverHost}  (用于团队应用 ${configData.appPrefix}*.${primaryDomain})`);
    if (isPrivateOrLocalHost(serverHost) && domainMode === 'letsencrypt') {
      console.log(`   ⚠️ 检测到内网地址 (${serverHost})：公网 HTTP-01 无法穿透内网签发证书。`);
      console.log(`      推荐通过 acme.sh (DNS-01 泛域名证书) 配置内网 HTTPS:`);
      console.log(`      sudo vibedock tls --dns <dns_cf|dns_dp|dns_ali>`);
      console.log(`      或绑定已有证书: sudo vibedock tls --cert /var/lib/vibedock/certs/fullchain.pem --key /var/lib/vibedock/certs/privkey.pem`);
    }
  }

  console.log('\n下一步命令：');
  console.log('   1. 安装/检查 Ubuntu 生产底座: sudo vibedock setup && vibedock doctor');
  console.log('   2. 启动门户与 AI 诊断服务:    vibedock start --daemon\n');
}

function parseDbTypes(rawTypes: string | boolean | string[] | undefined): DatabaseEngine[] {
  const valid: DatabaseEngine[] = ['postgresql', 'mysql', 'mongodb', 'redis'];
  if (!rawTypes || rawTypes === 'all' || rawTypes === true) return valid;
  const parts = String(rawTypes)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes('all')) return valid;
  return parts.filter((p): p is DatabaseEngine => valid.includes(p as DatabaseEngine));
}

async function cmdDb(sub: string, flags: ParsedFlags): Promise<void> {
  const cfg = loadVibeDockConfig();
  let { dbEnvFile, adminData } = ensureDbSecrets(cfg);
  const composeFile = cfg.databases.composeFile;

  if (sub === 'up') {
    const requestedTypes = flags.types ? parseDbTypes(flags.types) : parseDbTypes(cfg.databases.enabled);
    const strategyFlag = flags.strategy === 'reuse' || flags['db-strategy'] === 'reuse' ? 'reuse' : 'dedicated';
    const runningContainers = getRunningVibeDockDbContainers();
    const occupiedDbs: Partial<Record<DatabaseEngine, boolean>> = {};
    for (const eng of requestedTypes) {
      if (adminData[eng]?.mode === 'external') continue;
      const containerName = VIBEDOCK_DB_CONTAINERS[eng];
      if (runningContainers.has(containerName)) continue;
      const targetPort = Number(adminData[eng]?.port || DEFAULT_DB_PORTS[eng]);
      if (await probePortListening(targetPort, '127.0.0.1')) {
        occupiedDbs[eng] = true;
      }
    }
    if (Object.keys(occupiedDbs).length > 0) {
      const updated = ensureDbSecrets(cfg, { dbStrategy: strategyFlag, occupiedDbs });
      dbEnvFile = updated.dbEnvFile;
      adminData = updated.adminData;
      for (const eng of Object.keys(occupiedDbs) as DatabaseEngine[]) {
        if (strategyFlag === 'dedicated') {
          console.log(
            `⚡ 检测到本机 ${eng} 默认端口 (${DEFAULT_DB_PORTS[eng]}) 已被已有服务占用，已自动将 VibeDock 专用容器切换至并存端口 ${adminData[eng].port}`,
          );
        } else {
          console.log(`ℹ️ 检测到本机 ${eng} 默认端口已占用，已按 reuse 策略标记为 external 实例`);
        }
      }
    }

    const externalTypes = requestedTypes.filter((t) => adminData[t]?.mode === 'external');
    const dockerTypes = requestedTypes.filter((t) => adminData[t]?.mode !== 'external');
    if (externalTypes.length > 0) {
      console.log(`ℹ️ 跳过外部/宿主机已纳管数据库 (${externalTypes.join(', ')})，保持原有实例运行`);
    }
    if (dockerTypes.length === 0) {
      console.log('✅ 所有目标数据库均由外部/宿主机实例提供，无需启动额外 Docker 容器。');
      return;
    }
    const profileArgs = dockerTypes.flatMap((t) => ['--profile', t]);
    console.log(
      `==> 正在通过 Docker Compose 启动专用数据库容器: ${dockerTypes.map((t) => `${t}:${adminData[t]?.port || DEFAULT_DB_PORTS[t]}`).join(', ')} ...`,
    );
    const res = spawnSync('docker', ['compose', '--env-file', dbEnvFile, '-f', composeFile, ...profileArgs, 'up', '-d'], {
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  }

  if (sub === 'down') {
    const res = spawnSync('docker', ['compose', '--env-file', dbEnvFile, '-f', composeFile, '--profile', 'all', 'down'], {
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  }

  if (sub === 'register') {
    const engine = String(flags._[2] || '').toLowerCase() as DatabaseEngine;
    const valid: DatabaseEngine[] = ['postgresql', 'mysql', 'mongodb', 'redis'];
    if (!valid.includes(engine)) {
      throw new Error(
        'Usage: vibedock db register <postgresql|mysql|mongodb|redis> [--host 127.0.0.1] [--port ...] [--user ...] [--password ...] [--url ...]',
      );
    }
    const inst = registerDbInstance(cfg, engine, {
      host: flags.host ? String(flags.host) : undefined,
      port: flags.port ? Number(flags.port) : undefined,
      user: flags.user ? String(flags.user) : undefined,
      password: flags.password !== undefined ? String(flags.password) : undefined,
      url: flags.url ? String(flags.url) : undefined,
      mode: flags.mode === 'docker' ? 'docker' : 'external',
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          engine,
          instance: {
            host: inst.host,
            port: inst.port,
            user: inst.user,
            mode: inst.mode || 'external',
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (sub === 'bind') {
    const project = flags._[2];
    if (!project) {
      throw new Error(
        'Usage: vibedock db bind <project-id> [--postgresql <url>] [--mysql <url>] [--mongodb <url>] [--redis <url>] [--type <engine> --url <url>] [--format json|env]',
      );
    }
    const bindings: Partial<Record<DatabaseEngine, string>> = {};
    for (const eng of ['postgresql', 'mysql', 'mongodb', 'redis'] as DatabaseEngine[]) {
      if (typeof flags[eng] === 'string' && flags[eng]) {
        bindings[eng] = String(flags[eng]);
      }
    }
    if (typeof flags.type === 'string' && typeof flags.url === 'string') {
      const eng = flags.type.toLowerCase() as DatabaseEngine;
      if (['postgresql', 'mysql', 'mongodb', 'redis'].includes(eng)) {
        bindings[eng] = String(flags.url);
      }
    }
    if (Object.keys(bindings).length === 0) {
      throw new Error('请至少提供一个数据库连接串，例如: --postgresql "postgresql://user:pass@host:5432/db"');
    }
    const record = bindProjectDbs(cfg, project, bindings);
    if (flags.format === 'env') {
      console.log(formatDbEnv(record));
    } else {
      console.log(JSON.stringify({ ok: true, result: record }, null, 2));
    }
    return;
  }

  if (sub === 'provision') {
    const project = flags._[2];
    if (!project) throw new Error('Usage: vibedock db provision <project-id> [--types all] [--format json|env]');
    const types = parseDbTypes(flags.types);
    const record = provisionProjectDbs(cfg, project, types);
    if (flags.format === 'env') {
      console.log(formatDbEnv(record));
    } else {
      console.log(JSON.stringify({ ok: true, result: record }, null, 2));
    }
    return;
  }

  if (sub === 'get') {
    const project = flags._[2];
    if (!project) throw new Error('Usage: vibedock db get <project-id> [--format json|env]');
    const record = getProjectDbRecord(cfg, project);
    if (flags.format === 'env') {
      console.log(formatDbEnv(record));
    } else {
      console.log(JSON.stringify({ ok: true, result: record }, null, 2));
    }
    return;
  }

  if (sub === 'backup') {
    const project = flags._[2] ? String(flags._[2]) : undefined;
    const keepDays = flags['keep-days'] ? Number(flags['keep-days']) : 7;
    const result = backupProjectDbs(cfg, { project, keepDays });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  const status = getDbStatus(cfg);
  console.log(JSON.stringify({ ok: true, result: status }, null, 2));
}

function cmdAdopt(flags: ParsedFlags): void {
  const cfg = loadVibeDockConfig();
  const id = String(flags._[1] || flags.id || '').trim();
  const upstream = String(flags.upstream || flags.target || flags.url || '').trim();
  if (!id || !upstream) {
    throw new Error(
      'Usage: vibedock adopt <project-id> --upstream <http://host:port> [--name <name>] [--owner <owner>] [--description <desc>] [--path /*]',
    );
  }
  const manifest: PublishManifest = {
    id,
    name: flags.name ? String(flags.name) : id,
    owner: flags.owner ? String(flags.owner) : 'Infra',
    description: flags.description ? String(flags.description) : `Adopted existing service (${upstream})`,
    tags: ['存量纳管'],
    components: [
      {
        id: 'upstream',
        kind: 'external',
        upstream,
      },
    ],
    routes: [
      {
        component: 'upstream',
        path: flags.path ? String(flags.path) : '/*',
      },
    ],
  };
  const result = publishApp(cfg, manifest);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

function cmdPublishFromStdinOrFile(flags: ParsedFlags): void {
  const cfg = loadVibeDockConfig();
  const fileArg = flags._[1];
  const raw = fileArg ? fs.readFileSync(fileArg, 'utf8') : fs.readFileSync(0, 'utf8');
  if (!raw.trim()) {
    throw new Error('Expected JSON payload on stdin or file path');
  }
  const payload = JSON.parse(raw) as PublishManifest & { action?: string };
  const action = String(payload.action || 'publish').toLowerCase();
  if (action === 'alloc') {
    console.log(JSON.stringify(allocateAppSlot(cfg, payload.id || ''), null, 2));
  } else if (action === 'unpublish' || action === 'remove' || action === 'delete') {
    console.log(JSON.stringify(unpublishApp(cfg, payload.id), null, 2));
  } else {
    console.log(JSON.stringify(publishApp(cfg, payload), null, 2));
  }
}

function probeBin(bin: string, args: string[] = ['--version']): string | null {
  const res = spawnSync(bin, args, { encoding: 'utf8' });
  if (res.status === 0) {
    const lines = `${res.stdout || ''}\n${res.stderr || ''}`
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const out = bin === 'pm2' ? lines[lines.length - 1] : lines[0];
    return out || '已安装';
  }
  return null;
}

async function cmdDoctor(): Promise<void> {
  const cfg = loadVibeDockConfig();
  const isLinux = process.platform === 'linux';
  const hasConfig = fs.existsSync(cfg.configPath);
  const hasSkillZip = fs.existsSync(cfg.paths.skillZipFile);
  const gateway = cfg.gateway || 'caddy';
  const caddyVer = probeBin(cfg.paths.caddyBin || 'caddy', ['version']);
  const nginxVer = probeBin(cfg.paths.nginxBin || 'nginx', ['-v']);
  const pm2Ver = probeBin('pm2', ['-v']);
  const uvVer = probeBin('uv', ['--version']);
  const rsyncVer = probeBin('rsync', ['--version']);
  const zipVer = probeBin('zip', ['-v']);
  const dockerVer = probeBin('docker', ['compose', 'version']);

  const portalHost = `portal.${cfg.primaryDomain}`;
  let dnsStatusLine = '';
  try {
    const resolved = await dns.lookup(portalHost);
    dnsStatusLine = `✅ 域名 DNS 解析:    ${portalHost} -> ${resolved.address}`;
  } catch {
    dnsStatusLine = `⚠️ 域名 DNS 解析:    ${portalHost} 尚未解析 (请配置 A 记录 *.${cfg.primaryDomain} -> ${cfg.serverHost})`;
  }

  let tlsStatusLine = '';
  if (cfg.domainMode === 'nip') {
    tlsStatusLine = 'ℹ️ HTTPS/证书模式:   HTTP 免证书模式 (nip)';
  } else if (cfg.domainMode === 'custom') {
    const certOk = Boolean(cfg.tls?.certFile && fs.existsSync(cfg.tls.certFile));
    const keyOk = Boolean(cfg.tls?.keyFile && fs.existsSync(cfg.tls.keyFile));
    tlsStatusLine =
      certOk && keyOk
        ? `✅ HTTPS/证书模式:   自定义/acme.sh 证书已就绪 (${cfg.tls!.certFile})`
        : `❌ HTTPS/证书模式:   custom 模式证书文件缺失 (${cfg.tls?.certFile || '未配置'})`;
  } else if (isPrivateOrLocalHost(cfg.serverHost)) {
    tlsStatusLine = `⚠️ HTTPS/证书模式:   letsencrypt 模式但当前为内网地址 (${cfg.serverHost})，建议使用 sudo vibedock tls 配置 acme.sh 证书`;
  } else {
    tlsStatusLine = "ℹ️ HTTPS/证书模式:   Caddy Auto-HTTPS (Let's Encrypt / ZeroSSL 自动按需签发)";
  }

  let gatewayStatusLine = '';
  let gatewayOk = true;
  const strategy = cfg.gatewayStrategy || (gateway === 'none' ? 'none' : 'reuse');
  if (strategy === 'dedicated-chain') {
    gatewayOk = Boolean(caddyVer);
    gatewayStatusLine = `${gatewayOk ? '✅' : '❌'} 专用网关 (串联): ${caddyVer || '未安装'} (监听 127.0.0.1:${cfg.gatewayHttpPort || 39080}，与外层网关双层串联共存)`;
  } else if (strategy === 'dedicated-port') {
    gatewayOk = Boolean(caddyVer);
    gatewayStatusLine = `${gatewayOk ? '✅' : '❌'} 专用网关 (独立): ${caddyVer || '未安装'} (独立端口 HTTP=${cfg.gatewayHttpPort || 8080} / HTTPS=${cfg.gatewayHttpsPort || 8443}，零侵入并存)`;
  } else if (gateway === 'nginx') {
    gatewayOk = Boolean(nginxVer);
    gatewayStatusLine = `${gatewayOk ? '✅' : '❌'} Nginx 网关:      ${nginxVer || '未安装'} (复用本机 Nginx drop-in 模式)`;
  } else if (gateway === 'none') {
    gatewayOk = true;
    gatewayStatusLine = 'ℹ️ 网关模式:         none (外部 SLB / Cloudflare Tunnel / FRP 透传模式)';
  } else {
    gatewayOk = Boolean(caddyVer);
    gatewayStatusLine = `${gatewayOk ? '✅' : '❌'} Caddy 网关:      ${caddyVer || '未安装'} (复用本机 Caddy 模式)`;
  }

  console.log(`=== ${cfg.brandName} 全量底座自检 (Doctor) ===`);
  console.log(`✅ Node.js 运行时:  ${process.version} (${process.platform}/${process.arch})`);
  console.log(`${hasConfig ? '✅' : '⚠️'} 配置文件路径:    ${cfg.configPath} (${hasConfig ? '已生成' : '未生成，使用默认回退值'})`);
  console.log(`ℹ️ 服务器与域名:    ${cfg.serverHost} -> *.${cfg.primaryDomain} (${cfg.domainMode})`);
  console.log(dnsStatusLine);
  console.log(tlsStatusLine);
  console.log(`${hasSkillZip ? '✅' : '⚠️'} Skill 安装包:    ${cfg.paths.skillZipFile} (${hasSkillZip ? '已就绪' : '未生成'})`);
  console.log(gatewayStatusLine);
  console.log(`${pm2Ver ? '✅' : '❌'} PM2 进程守护:    ${pm2Ver ? `v${pm2Ver}` : '未安装'}`);
  console.log(`${uvVer ? '✅' : '⚠️'} Python uv:       ${uvVer || '未安装 (Python 应用需要)'}`);
  console.log(`${rsyncVer && zipVer ? '✅' : '❌'} 同步与打包工具:  rsync=${rsyncVer ? '就绪' : '缺失'}, zip=${zipVer ? '就绪' : '缺失'}`);
  console.log(`${dockerVer ? '✅' : '⚠️'} Docker Compose:  ${dockerVer || '未检测到 (可通过 vibedock db register/bind 接入已有数据库)'}`);

  let hostReady = Boolean(gatewayOk && pm2Ver && rsyncVer && zipVer);
  if (isLinux) {
    const userCheck = spawnSync('id', ['-u', cfg.deployUser], { encoding: 'utf8' });
    const hasDeployUser = userCheck.status === 0;
    const hasSudoers = fs.existsSync('/etc/sudoers.d/vibedock');
    console.log(`${hasDeployUser ? '✅' : '❌'} 受限部署账号:    ${cfg.deployUser} (${hasDeployUser ? `uid=${userCheck.stdout.trim()}` : '未创建'})`);
    console.log(`${hasSudoers ? '✅' : '❌'} Sudoers 白名单:  /etc/sudoers.d/vibedock (${hasSudoers ? '已配置' : '未配置'})`);
    hostReady = hostReady && hasDeployUser && hasSudoers;
  }

  if (!hasConfig || !hasSkillZip || !hostReady) {
    console.log('\n💡 修复与引导建议:');
    if (!hasConfig || !hasSkillZip) {
      console.log('   1. 初始化配置与生成 Skill 包:  vibedock init --yes');
    }
    if (!hostReady) {
      console.log('   2. 一键安装 Ubuntu 生产底座:   sudo vibedock setup');
    }
  } else {
    console.log('\n🎉 所有核心底座与部署链路均已就绪！');
  }
}

function resolveAcmeDnsEnv(
  rawProvider: string,
  flags: ParsedFlags,
  acmeDir?: string,
): { provider: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const secretId = String(
    flags['secret-id'] || env.SecretId || env.Tencent_SecretId || env.DP_Id || env.Ali_Key || env.CF_Token || '',
  ).trim();
  const secretKey = String(
    flags['secret-key'] || env.SecretKey || env.Tencent_SecretKey || env.DP_Key || env.Ali_Secret || '',
  ).trim();
  const norm = rawProvider.trim().toLowerCase();
  const acctConf =
    acmeDir && fs.existsSync(path.join(acmeDir, 'account.conf'))
      ? fs.readFileSync(path.join(acmeDir, 'account.conf'), 'utf8')
      : '';

  if (norm === 'dnspod' || norm === 'dns_dp' || norm === 'tencent' || norm === 'dns_tencent') {
    if (
      secretId.startsWith('AKID') ||
      norm === 'tencent' ||
      norm === 'dns_tencent' ||
      (!secretId && acctConf.includes('SAVED_Tencent_SecretId'))
    ) {
      if (secretId) env.Tencent_SecretId = secretId;
      if (secretKey) env.Tencent_SecretKey = secretKey;
      return { provider: 'dns_tencent', env };
    }
    if (secretId) env.DP_Id = secretId;
    if (secretKey) env.DP_Key = secretKey;
    return { provider: 'dns_dp', env };
  }

  if (norm === 'aliyun' || norm === 'ali' || norm === 'dns_ali') {
    if (secretId) env.Ali_Key = secretId;
    if (secretKey) env.Ali_Secret = secretKey;
    return { provider: 'dns_ali', env };
  }

  if (norm === 'cf' || norm === 'cloudflare' || norm === 'dns_cf') {
    if (secretId) env.CF_Token = secretId;
    return { provider: 'dns_cf', env };
  }

  return { provider: rawProvider.trim(), env };
}

function cmdTls(flags: ParsedFlags): void {
  const cfg = loadVibeDockConfig();
  const certDir = path.join(cfg.paths.dataDir, 'certs');
  const certFile = flags.cert ? String(flags.cert).trim() : path.join(certDir, 'fullchain.pem');
  const keyFile = flags.key ? String(flags.key).trim() : path.join(certDir, 'privkey.pem');
  const dnsProvider = flags.dns ? String(flags.dns).trim() : '';
  const domain = flags.domain ? String(flags.domain).trim() : cfg.primaryDomain;

  if (dnsProvider) {
    const acmeDir = path.join(cfg.paths.dataDir, 'acme');
    fs.mkdirSync(acmeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(acmeDir, 0o700);
    if (process.platform === 'linux' && spawnSync('which', ['crontab']).status !== 0) {
      spawnSync('bash', ['-c', 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq cron && (systemctl enable --now cron 2>/dev/null || service cron start 2>/dev/null || true)'], { stdio: 'ignore' });
    }
    const acmeBin = path.join(acmeDir, 'acme.sh');
    if (!fs.existsSync(acmeBin)) {
      console.log(`==> 正在安装 acme.sh 至 ${acmeDir} ...`);
      const installRes = spawnSync(
        'bash',
        ['-c', `curl -fsSL https://get.acme.sh | sh -s email=admin@${domain} --home "${acmeDir}" --nocron`],
        { cwd: os.tmpdir(), stdio: 'inherit' },
      );
      if (installRes.status !== 0) {
        throw new Error('acme.sh 安装失败');
      }
    }
    if (spawnSync('which', ['crontab']).status === 0) {
      spawnSync(acmeBin, ['--home', acmeDir, '--install-cronjob'], { stdio: 'ignore' });
    }
    fs.mkdirSync(certDir, { recursive: true, mode: 0o750 });
    fs.chmodSync(certDir, 0o750);
    spawnSync('chown', ['root:caddy', certDir]);
    const { provider, env: acmeEnv } = resolveAcmeDnsEnv(dnsProvider, flags, acmeDir);
    const issueArgs = [
      '--home',
      acmeDir,
      '--issue',
      '--dns',
      provider,
      '-d',
      domain,
      '-d',
      `*.${domain}`,
      '--server',
      'letsencrypt',
    ];
    console.log(`==> 正在通过 acme.sh (${provider}) 申请泛域名证书 (*.${domain}) ...`);
    const issueRes = spawnSync(acmeBin, issueArgs, { env: acmeEnv, stdio: 'inherit' });
    if (issueRes.status !== 0 && issueRes.status !== 2) {
      throw new Error('acme.sh 证书签发失败，请检查 DNS API 环境变量或网络连通性');
    }
    const reloadCmd =
      cfg.gateway === 'nginx'
        ? `chmod 644 ${certFile} && chmod 640 ${keyFile} && nginx -s reload || true`
        : `chown root:caddy ${keyFile} 2>/dev/null || true; chmod 644 ${certFile} && chmod 640 ${keyFile} && caddy reload --config ${cfg.paths.caddyConfig} || true`;
    const installCertRes = spawnSync(
      acmeBin,
      [
        '--home',
        acmeDir,
        '--install-cert',
        '-d',
        domain,
        '--fullchain-file',
        certFile,
        '--key-file',
        keyFile,
        '--reloadcmd',
        reloadCmd,
      ],
      { env: acmeEnv, stdio: 'inherit' },
    );
    if (installCertRes.status !== 0) {
      throw new Error('acme.sh 证书安装失败');
    }
  } else if (!flags.cert || !flags.key) {
    console.log(
      [
        '用法: vibedock tls <选项>',
        '  1. 使用 acme.sh DNS-01 申请泛域名证书 (支持解析到内网 IP 的域名):',
        '     sudo vibedock tls --dns <dnspod|aliyun|cf> [--secret-id <ID> --secret-key <KEY>]',
        '  2. 绑定已有的 acme.sh 或企业/内网证书文件:',
        '     sudo vibedock tls --cert /var/lib/vibedock/certs/fullchain.pem --key /var/lib/vibedock/certs/privkey.pem',
      ].join('\n'),
    );
    return;
  }

  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    throw new Error(`证书或私钥文件不存在: cert=${certFile}, key=${keyFile}`);
  }
  const certBody = fs.readFileSync(certFile, 'utf8');
  const keyBody = fs.readFileSync(keyFile, 'utf8');
  if (!certBody.includes('-----BEGIN CERTIFICATE-----') || !keyBody.includes('PRIVATE KEY-----')) {
    throw new Error('证书或私钥文件不是有效的 PEM 格式');
  }
  if (fs.existsSync(certDir)) {
    fs.chmodSync(certDir, 0o750);
  }
  fs.chmodSync(certFile, 0o644);
  fs.chmodSync(keyFile, 0o640);
  if (process.platform === 'linux') {
    if (fs.existsSync(certDir)) spawnSync('chown', ['root:caddy', certDir]);
    spawnSync('chown', ['root:caddy', keyFile]);
  }

  const hadPrevCfg = fs.existsSync(cfg.configPath);
  const prevCfgText = hadPrevCfg ? fs.readFileSync(cfg.configPath, 'utf8') : null;
  const catalogPath = path.join(cfg.paths.dataDir, 'catalog.json');
  const prevCatalogText = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : null;
  const portalCaddyFile = path.join(cfg.paths.caddySitesDir, '00-vibedock-portal.caddy');
  const prevPortalCaddyText = fs.existsSync(portalCaddyFile) ? fs.readFileSync(portalCaddyFile, 'utf8') : null;
  const nginxSitesDir = cfg.paths.nginxSitesDir || path.join(cfg.paths.dataDir, 'nginx/sites');
  const portalNginxFile = path.join(nginxSitesDir, '00-vibedock-portal.conf');
  const prevPortalNginxText = fs.existsSync(portalNginxFile) ? fs.readFileSync(portalNginxFile, 'utf8') : null;

  const restorePrevious = () => {
    if (hadPrevCfg && prevCfgText !== null) {
      fs.writeFileSync(cfg.configPath, prevCfgText, { mode: 0o600 });
    }
    if (prevCatalogText !== null) {
      fs.writeFileSync(catalogPath, prevCatalogText, 'utf8');
    }
    if (prevPortalCaddyText !== null) {
      fs.writeFileSync(portalCaddyFile, prevPortalCaddyText, 'utf8');
    }
    if (prevPortalNginxText !== null) {
      fs.writeFileSync(portalNginxFile, prevPortalNginxText, 'utf8');
    }
  };

  const rawCfg = hadPrevCfg ? JSON.parse(prevCfgText!) : {};
  rawCfg.domainMode = 'custom';
  rawCfg.portalUrl = `https://portal.${cfg.primaryDomain}`;
  rawCfg.tls = { certFile, keyFile };
  fs.writeFileSync(cfg.configPath, `${JSON.stringify(rawCfg, null, 2)}\n`, { mode: 0o600 });

  const updatedCfg = loadVibeDockConfig(cfg.configPath);
  syncCatalogEnvironment(updatedCfg);
  const gateway = updatedCfg.gateway || 'caddy';
  if (gateway === 'nginx') {
    fs.mkdirSync(nginxSitesDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(portalNginxFile, buildPortalNginxBlock(updatedCfg), 'utf8');
    const nginxCfgFile = updatedCfg.paths.nginxConfig || '/etc/nginx/nginx.conf';
    if (fs.existsSync(nginxCfgFile)) {
      const val = spawnSync(updatedCfg.paths.nginxBin || 'nginx', ['-t'], { encoding: 'utf8' });
      if (val.status !== 0) {
        restorePrevious();
        throw new Error(`Nginx TLS 校验失败，已自动回滚: ${(val.stderr || val.stdout).trim()}`);
      }
      const rel = spawnSync(updatedCfg.paths.nginxBin || 'nginx', ['-s', 'reload'], { encoding: 'utf8' });
      if (rel.status !== 0) {
        restorePrevious();
        throw new Error(`Nginx TLS 重载失败，已自动回滚: ${(rel.stderr || rel.stdout).trim()}`);
      }
    }
  } else if (gateway === 'caddy') {
    fs.mkdirSync(updatedCfg.paths.caddySitesDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(portalCaddyFile, buildPortalCaddyBlock(updatedCfg), 'utf8');

    if (fs.existsSync(updatedCfg.paths.caddyConfig)) {
      const val = spawnSync(
        updatedCfg.paths.caddyBin || 'caddy',
        ['validate', '--config', updatedCfg.paths.caddyConfig, '--adapter', 'caddyfile'],
        { encoding: 'utf8' },
      );
      if (val.status !== 0) {
        restorePrevious();
        throw new Error(`Caddy TLS 校验失败，已自动回滚: ${(val.stderr || val.stdout).trim()}`);
      }
      const rel = spawnSync(
        updatedCfg.paths.caddyBin || 'caddy',
        ['reload', '--config', updatedCfg.paths.caddyConfig, '--adapter', 'caddyfile'],
        { encoding: 'utf8' },
      );
      if (rel.status !== 0) {
        restorePrevious();
        throw new Error(`Caddy TLS 重载失败，已自动回滚: ${(rel.stderr || rel.stdout).trim()}`);
      }
    }
  }

  packSkill(updatedCfg);

  console.log(`✅ 已启用 HTTPS 自定义/acme.sh 证书:`);
  console.log(`   - 证书文件: ${certFile}`);
  console.log(`   - 私钥文件: ${keyFile}`);
  console.log(`   - 门户地址: ${updatedCfg.portalUrl}`);
}

function cmdSetup(): void {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'setup-ubuntu-host.sh');
  const res = spawnSync('bash', [scriptPath], { stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

function cmdStart(flags: ParsedFlags): void {
  const cfg = loadVibeDockConfig();
  const serverEntry = path.join(PROJECT_ROOT, 'dist', 'server.js');
  const portalPm2Home = path.join(cfg.paths.dataDir, 'pm2');
  fs.mkdirSync(portalPm2Home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, PM2_HOME: portalPm2Home };
  if (flags.daemon || flags.pm2 || flags.d) {
    spawnSync('pm2', ['delete', 'vibedock-portal'], { stdio: 'ignore' });
    spawnSync('pm2', ['delete', 'vibedock-portal'], { env, stdio: 'ignore' });
    const res = spawnSync('pm2', ['start', serverEntry, '--name', 'vibedock-portal', '--cwd', PROJECT_ROOT], {
      env,
      stdio: 'inherit',
    });
    spawnSync('pm2', ['save'], { env, stdio: 'ignore' });
    process.exit(res.status ?? 0);
  }
  const res = spawnSync(process.execPath, [serverEntry], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });
  process.exit(res.status ?? 0);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cmd = flags._[0] || 'help';

  if (cmd === 'init') {
    await cmdInit(flags);
  } else if (cmd === 'setup') {
    cmdSetup();
  } else if (cmd === 'start') {
    cmdStart(flags);
  } else if (cmd === 'pack-skill') {
    const cfg = loadVibeDockConfig();
    const { zipPath } = packSkill(cfg);
    console.log(`✅ 已重新烘焙团队专属 AI Skill 包: ${zipPath}`);
  } else if (cmd === 'db') {
    await cmdDb(flags._[1] || 'status', flags);
  } else if (cmd === 'sync-gateway') {
    const cfg = loadVibeDockConfig();
    const { pubFile } = ensureDeployKeypair(cfg);
    syncHostIntegrationIfReady(cfg, pubFile);
  } else if (cmd === 'adopt') {
    cmdAdopt(flags);
  } else if (cmd === 'publish') {
    cmdPublishFromStdinOrFile(flags);
  } else if (cmd === 'alloc') {
    const cfg = loadVibeDockConfig();
    console.log(JSON.stringify(allocateAppSlot(cfg, flags._[1] || ''), null, 2));
  } else if (cmd === 'unpublish') {
    const cfg = loadVibeDockConfig();
    if (!flags._[1]) throw new Error('Usage: vibedock unpublish <project-id>');
    console.log(JSON.stringify(unpublishApp(cfg, flags._[1]), null, 2));
  } else if (cmd === 'doctor') {
    await cmdDoctor();
  } else if (cmd === 'tls') {
    cmdTls(flags);
  } else {
    console.log(
      [
        'VibeDock CLI (v0.0.5) — 自建 AI-Native 团队应用与数据库云',
        '',
        '常用命令:',
        '  vibedock setup                           一键安装 Ubuntu 生产底座 (自动识别已有 Nginx 或安装 Caddy)',
        '  vibedock init [--gateway-strategy ...]   初始化配置、自主选择网关/数据库新旧共存策略并烘焙 AI Skill 包',
        '  vibedock tls [--dns|--cert]              使用 acme.sh (DNS-01) 签发泛域名证书或绑定自定义 HTTPS 证书',
        '  vibedock start [--daemon]                启动门户与 AI 诊断服务 (--daemon 使用 PM2 后台守护)',
        '  vibedock doctor                          检查本机核心底座依赖、DNS 泛解析与 HTTPS 证书状态',
        '  vibedock db up [--types ...]             使用 Docker Compose 一键启动内置共享数据库',
        '  vibedock db register <engine> [...]      纳管本机已安装或远程/RDS 数据库实例 (自动按项目分库)',
        '  vibedock db bind <id> [--postgresql ...] 为项目直接绑定已有的外部数据库连接串 (无需管理员密码)',
        '  vibedock db status                       查看数据库运行状态、纳管模式与已开通项目',
        '  vibedock db provision <id> [--types all] 为项目幂等开通 PostgreSQL/MySQL/MongoDB/Redis',
        '  vibedock db get <id> [--format env]      获取项目已开通或绑定的数据库连接串',
        '  vibedock db backup [id] [--keep-days 7]  导出项目数据库备份至 /var/lib/vibedock/backups/databases',
        '  vibedock db down                         停止内置共享数据库容器',
        '  vibedock adopt <id> --upstream <url>     一键纳管本机/内网已有服务并自动挂载子域名与门户卡片',
        '  vibedock alloc [id]                      查询下一个空闲端口及项目 ID 占用状态',
        '  vibedock publish [manifest.json]         执行应用发布并热重载网关路由',
        '  vibedock unpublish <id>                  一键下线项目、停止 PM2 进程并释放路由',
        '  vibedock pack-skill                      根据当前配置重新打包 data/vibedock-deploy.zip',
      ].join('\n'),
    );
  }
}

main().catch((err: any) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
});
