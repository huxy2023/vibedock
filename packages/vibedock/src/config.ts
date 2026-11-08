import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VibeDockConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
export const PROJECT_ROOT = ROOT_DIR;

export function resolveStateRoot(): string {
  if (process.env.VIBEDOCK_HOME) {
    return path.resolve(process.env.VIBEDOCK_HOME);
  }
  if (
    process.platform === 'linux' &&
    (fs.existsSync('/var/lib/vibedock') || (typeof process.getuid === 'function' && process.getuid() === 0))
  ) {
    return '/var/lib/vibedock';
  }
  return path.join(ROOT_DIR, 'data');
}

export function loadVibeDockConfig(customPath?: string): VibeDockConfig {
  const stateRoot = resolveStateRoot();
  const isUnifiedStateRoot = stateRoot === '/var/lib/vibedock' || Boolean(process.env.VIBEDOCK_HOME);
  const configPath =
    customPath ||
    process.env.VIBEDOCK_CONFIG ||
    (isUnifiedStateRoot ? path.join(stateRoot, 'vibedock.config.json') : path.join(ROOT_DIR, 'vibedock.config.json'));

  let raw: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error: any) {
      console.warn(`[vibedock] Failed to parse ${configPath}: ${error.message}`);
    }
  }

  const configBaseDir = path.dirname(configPath);
  const serverHost = process.env.VIBEDOCK_SERVER_HOST || raw.serverHost || '127.0.0.1';
  const primaryDomain = process.env.VIBEDOCK_PRIMARY_DOMAIN || raw.primaryDomain || `${serverHost}.nip.io`;
  const backupDomain = process.env.VIBEDOCK_BACKUP_DOMAIN ?? raw.backupDomain ?? '';
  const dataDir = process.env.VIBEDOCK_DATA_DIR
    ? path.resolve(configBaseDir, process.env.VIBEDOCK_DATA_DIR)
    : raw.paths?.dataDir
      ? path.resolve(configBaseDir, raw.paths.dataDir)
      : stateRoot;

  if (dataDir !== path.join(ROOT_DIR, 'data') && fs.existsSync(dataDir)) {
    const targetCatalog = path.join(dataDir, 'catalog.json');
    const seedCatalog = path.join(ROOT_DIR, 'data', 'catalog.json');
    if (!fs.existsSync(targetCatalog) && fs.existsSync(seedCatalog)) {
      try {
        fs.copyFileSync(seedCatalog, targetCatalog);
      } catch {
        // Non-fatal if read-only
      }
    }
  }

  return {
    rootDir: ROOT_DIR,
    configPath,
    brandName: process.env.VIBEDOCK_BRAND_NAME || raw.brandName || 'VibeDock',
    portalTitle: process.env.VIBEDOCK_PORTAL_TITLE || raw.portalTitle || 'VibeDock · 团队应用与开发者门户',
    skillName: process.env.VIBEDOCK_SKILL_NAME || raw.skillName || 'vibedock-deploy',
    serverHost,
    sshPort: Number(process.env.VIBEDOCK_SSH_PORT || raw.sshPort || 22),
    deployUser: process.env.VIBEDOCK_DEPLOY_USER || raw.deployUser || 'vibe-deploy',
    appPrefix: process.env.VIBEDOCK_APP_PREFIX || raw.appPrefix || 'team-',
    domainMode: (process.env.VIBEDOCK_DOMAIN_MODE || raw.domainMode || 'nip') as VibeDockConfig['domainMode'],
    gateway: (process.env.VIBEDOCK_GATEWAY || raw.gateway || 'caddy') as VibeDockConfig['gateway'],
    gatewayStrategy: (process.env.VIBEDOCK_GATEWAY_STRATEGY || raw.gatewayStrategy || 'reuse') as VibeDockConfig['gatewayStrategy'],
    gatewayHttpPort: Number(process.env.VIBEDOCK_GATEWAY_HTTP_PORT || raw.gatewayHttpPort || 80),
    gatewayHttpsPort: Number(process.env.VIBEDOCK_GATEWAY_HTTPS_PORT || raw.gatewayHttpsPort || 443),
    primaryDomain,
    backupDomain,
    portalUrl: process.env.VIBEDOCK_PORTAL_URL || raw.portalUrl || 'http://127.0.0.1:39090',
    deployToken: process.env.VIBEDOCK_DEPLOY_TOKEN || raw.deployToken || '',
    tls: {
      certFile: process.env.VIBEDOCK_TLS_CERT || raw.tls?.certFile || '',
      keyFile: process.env.VIBEDOCK_TLS_KEY || raw.tls?.keyFile || '',
    },
    portRange: {
      start: Number(raw.portRange?.start || 40000),
      end: Number(raw.portRange?.end || 40999),
    },
    paths: {
      dataDir,
      appsDir: process.env.VIBEDOCK_APPS_DIR || raw.paths?.appsDir || path.join(dataDir, 'apps'),
      caddyBin: process.env.CADDY_BIN || raw.paths?.caddyBin || 'caddy',
      caddyConfig: process.env.CADDY_CONFIG || raw.paths?.caddyConfig || '/etc/caddy/Caddyfile',
      caddySitesDir: path.resolve(dataDir, process.env.CADDY_SITES_DIR || raw.paths?.caddySitesDir || 'caddy/sites'),
      nginxBin: process.env.NGINX_BIN || raw.paths?.nginxBin || 'nginx',
      nginxConfig: process.env.NGINX_CONFIG || raw.paths?.nginxConfig || '/etc/nginx/nginx.conf',
      nginxSitesDir: path.resolve(dataDir, process.env.NGINX_SITES_DIR || raw.paths?.nginxSitesDir || 'nginx/sites'),
      dbSecretsDir: path.resolve(dataDir, process.env.DB_SECRETS_DIR || raw.paths?.dbSecretsDir || 'secrets/databases'),
      skillZipFile: path.resolve(dataDir, process.env.SKILL_ZIP_FILE || raw.paths?.skillZipFile || 'vibedock-deploy.zip'),
    },
    databases: {
      mode: (raw.databases?.mode || 'docker') as VibeDockConfig['databases']['mode'],
      composeFile: path.resolve(ROOT_DIR, raw.databases?.composeFile || './docker/docker-compose.db.yml'),
      enabled: Array.isArray(raw.databases?.enabled) ? raw.databases.enabled : ['postgresql', 'mysql', 'mongodb', 'redis'],
    },
    auth: {
      defaultAdminUser: process.env.DEFAULT_ADMIN_USER || raw.auth?.defaultAdminUser || 'admin',
      defaultAdminDisplayName: process.env.DEFAULT_ADMIN_NAME || raw.auth?.defaultAdminDisplayName || '系统管理员',
      defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || raw.auth?.defaultAdminPassword || 'vibe2026',
      defaultMemberPassword: process.env.DEFAULT_MEMBER_PASSWORD || raw.auth?.defaultMemberPassword || 'vibe2026',
      defaultInviteCode: process.env.DEFAULT_INVITE_CODE ?? raw.auth?.defaultInviteCode ?? 'vibe2026',
    },
  };
}
