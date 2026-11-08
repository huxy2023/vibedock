import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCaddyConfig,
  createCatalogService,
  redactSnapshotForPublic,
  validateCatalog,
} from '../dist/services/catalog.js';
import { buildNginxConfig } from '../dist/deploy/caddy.js';
import { backupProjectDbs, bindProjectDbs, formatDbEnv, provisionProjectDbs, registerDbInstance } from '../dist/deploy/databases.js';
import { publishApp } from '../dist/deploy/publish.js';
import { buildActivateRemoteCmd, buildStartServiceRemoteCmd } from '../dist/skill/client.js';
import { loadVibeDockConfig } from '../dist/config.js';

function splitProjectCatalog() {
  return {
    environment: { name: 'test' },
    projects: [
      {
        id: 'shop',
        name: '商城',
        components: [
          {
            id: 'web',
            name: '前端',
            listeners: [{ id: 'http', protocol: 'http', host: '127.0.0.1', port: 3100 }],
          },
          {
            id: 'api',
            name: '后端',
            listeners: [{ id: 'http', protocol: 'http', host: '127.0.0.1', port: 8100 }],
          },
        ],
        ingressRules: [
          {
            id: 'web',
            match: { hosts: ['shop.vibe.example.com'], paths: ['/*'], protocol: 'http' },
            target: { component: 'web', listener: 'http' },
          },
          {
            id: 'api-path',
            match: { hosts: ['shop.vibe.example.com'], paths: ['/api/*'], protocol: 'http' },
            target: { component: 'api', listener: 'http' },
          },
          {
            id: 'api-host',
            match: { hosts: ['shop-api.vibe.example.com'], paths: ['/*'], protocol: 'http' },
            target: { component: 'api', listener: 'http' },
          },
        ],
      },
    ],
  };
}

function remoteHttpsCatalog() {
  return {
    environment: { name: 'test', gatewayPort: 80, gatewayTlsPort: 443 },
    projects: [
      {
        id: 'remote-api',
        name: '远程 API',
        components: [
          {
            id: 'api',
            name: 'API',
            type: 'backend',
            listeners: [{ id: 'http', protocol: 'http', scope: 'remote', host: '172.22.4.192', port: 80 }],
          },
        ],
        ingressRules: [
          {
            id: 'https-api',
            match: { hosts: ['api.vibe.example.com'], paths: ['/*'], protocol: 'http', scheme: 'https' },
            tls: { certificateFile: '/srv/certs/api/fullchain.pem', keyFile: '/srv/certs/api/privkey.pem' },
            target: { component: 'api', listener: 'http' },
          },
        ],
      },
    ],
  };
}

test('accepts a project with separate frontend/backend ports and host/path ingress', () => {
  assert.doesNotThrow(() => validateCatalog(splitProjectCatalog()));
});

test('rejects listener port ownership conflicts', () => {
  const catalog = splitProjectCatalog();
  catalog.projects[0].components[1].listeners[0].port = 3100;
  assert.throws(() => validateCatalog(catalog), /listener 127\.0\.0\.1:3100 is shared/);
});

test('requires non-loopback listeners to be explicitly marked remote', () => {
  const catalog = remoteHttpsCatalog();
  delete catalog.projects[0].components[0].listeners[0].scope;
  assert.throws(() => validateCatalog(catalog), /must be loopback-only/);
});

test('rejects conflicting host/path/protocol targets', () => {
  const catalog = splitProjectCatalog();
  catalog.projects[0].ingressRules.push({
    id: 'conflict',
    match: { hosts: ['shop.vibe.example.com'], paths: ['/*'], protocol: 'http' },
    target: { component: 'api', listener: 'http' },
  });
  assert.throws(() => validateCatalog(catalog), /ingress conflict/);
});

test('generates host and path routing with fallback ordered last', () => {
  const project = splitProjectCatalog().projects[0];
  const config = buildCaddyConfig(project);
  assert.match(config, /http:\/\/shop\.vibe\.example\.com/);
  assert.match(config, /handle \/api\/\*/);
  assert.match(config, /reverse_proxy 127\.0\.0\.1:8100/);
  assert.ok(config.indexOf('handle /api/*') < config.indexOf('\thandle {'));
  assert.match(config, /http:\/\/shop-api\.vibe\.example\.com/);
});

test('generates HTTPS, custom TLS files and an explicit remote HTTP upstream', () => {
  const project = remoteHttpsCatalog().projects[0];
  const config = buildCaddyConfig(project);
  assert.match(config, /https:\/\/api\.vibe\.example\.com/);
  assert.match(config, /tls \/srv\/certs\/api\/fullchain\.pem \/srv\/certs\/api\/privkey\.pem/);
  assert.match(config, /reverse_proxy http:\/\/172\.22\.4\.192:80/);
});

test('builds a status snapshot and hot-reloads when catalog.json changes on disk', async (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-catalog-reload-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalogFile = path.join(dir, 'catalog.json');
  const initial = splitProjectCatalog();
  fs.writeFileSync(catalogFile, JSON.stringify(initial, null, 2));

  const service = createCatalogService(validateCatalog(initial), {
    catalogFile,
    cacheMs: 0,
    checker: async () => ({ online: true, checkedAt: '2026-08-10T00:00:00.000Z' }),
  });
  const snapshot1 = await service.snapshot();
  assert.equal(snapshot1.projects.length, 1);

  const updated = splitProjectCatalog();
  updated.projects.push({
    id: 'team-new',
    name: '新上线应用',
    components: [{ id: 'web', name: 'web', type: 'static', staticRoot: '/srv/web', listeners: [] }],
    ingressRules: [],
  });
  const futureTime = new Date(Date.now() + 2000);
  fs.writeFileSync(catalogFile, JSON.stringify(updated, null, 2));
  fs.utimesSync(catalogFile, futureTime, futureTime);

  const snapshot2 = await service.snapshot();
  assert.equal(snapshot2.projects.length, 2);
  assert.equal(snapshot2.projects[1].id, 'team-new');
});

test('computes DX port pool and redacts sensitive paths for public snapshot', async () => {
  const catalog = validateCatalog({
    environment: { name: 'test' },
    projects: [
      {
        id: 'team-demo',
        name: '同事应用',
        projectPath: '/var/lib/vibe-deploy/apps/demo/current',
        configPath: '/etc/caddy/sites/team-demo.caddy',
        components: [
          { id: 'web', name: 'web', type: 'static', staticRoot: '/var/lib/vibe-deploy/apps/demo/current/web', listeners: [] },
          { id: 'api', name: 'api', listeners: [{ id: 'http', protocol: 'http', host: '127.0.0.1', port: 40000 }] },
        ],
        ingressRules: [
          {
            id: 'r0',
            match: { scheme: 'https', hosts: ['team-demo.internal.example.com'], paths: ['/*'], protocol: 'http' },
            tls: { certificateFile: '/srv/certs/fullchain.pem', keyFile: '/srv/certs/privkey.pem' },
            target: { component: 'api', listener: 'http' },
          },
        ],
        commands: [{ label: 'secret', command: 'curl -u user:pass http://127.0.0.1:40000' }],
      },
    ],
  });
  const service = createCatalogService(catalog, {
    cacheMs: 0,
    checker: async () => ({ online: true, checkedAt: '2026-11-05T00:00:00.000Z' }),
  });
  const snapshot = await service.snapshot();
  assert.equal(snapshot.dx.portPool.nextAvailablePort, 40001);
  assert.equal(snapshot.dx.databases.length, 4);

  const redacted = redactSnapshotForPublic(snapshot);
  assert.equal(redacted.projects[0].projectPath, undefined);
  assert.equal(redacted.projects[0].configPath, undefined);
  assert.equal(redacted.projects[0].commands.length, 0);
  assert.deepEqual(redacted.projects[0].ingressRules[0].tls, { managed: true });
  assert.equal(redacted.projects[0].components[0].staticRoot, '[受保护静态站点目录]');
});

test('generates Nginx drop-in server blocks for static and upstream services', () => {
  const project = remoteHttpsCatalog().projects[0];
  const nginxConf = buildNginxConfig(project);
  assert.match(nginxConf, /server \{/);
  assert.match(nginxConf, /listen 443 ssl;/);
  assert.match(nginxConf, /ssl_certificate \/srv\/certs\/api\/fullchain\.pem;/);
  assert.match(nginxConf, /server_name api\.vibe\.example\.com;/);
  assert.match(nginxConf, /proxy_pass http:\/\/172\.22\.4\.192:80;/);
});

test('supports adopting existing upstream services (including https://) and Nginx gateway mode without local appDir', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-byoi-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgFile = path.join(dir, 'vibedock.config.json');
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      serverHost: '192.168.1.10',
      primaryDomain: 'vd.example.com',
      domainMode: 'letsencrypt',
      gateway: 'nginx',
      paths: {
        dataDir: dir,
        appsDir: path.join(dir, 'apps'),
        caddySitesDir: path.join(dir, 'caddy/sites'),
        nginxSitesDir: path.join(dir, 'nginx/sites'),
        nginxConfig: path.join(dir, 'nonexistent-nginx.conf'),
        dbSecretsDir: path.join(dir, 'secrets/databases'),
      },
    }),
  );
  const cfg = loadVibeDockConfig(cfgFile);
  const res = publishApp(cfg, {
    id: 'grafana',
    name: 'Grafana 监控看板',
    owner: 'SRE',
    description: '纳管现有 HTTPS Grafana 监控面板',
    components: [{ id: 'upstream', kind: 'external', upstream: 'https://10.0.0.20:8443' }],
  });
  assert.equal(res.projectId, 'team-grafana');
  assert.deepEqual(res.urls, ['http://team-grafana.vd.example.com']);
  const nginxSite = fs.readFileSync(path.join(dir, 'nginx/sites/team-grafana.conf'), 'utf8');
  assert.match(nginxSite, /listen 80;/);
  assert.match(nginxSite, /server_name team-grafana\.vd\.example\.com;/);
  assert.match(nginxSite, /proxy_pass https:\/\/10\.0\.0\.20:8443;/);
});

test('supports registering external DB instances and binding project connection URLs directly', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-db-bind-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgFile = path.join(dir, 'vibedock.config.json');
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      paths: {
        dataDir: dir,
        dbSecretsDir: path.join(dir, 'secrets/databases'),
      },
    }),
  );
  const cfg = loadVibeDockConfig(cfgFile);
  const reg = registerDbInstance(cfg, 'postgresql', {
    url: 'postgresql://dbadmin:secret123@10.0.0.50:5432/postgres',
  });
  assert.equal(reg.host, '10.0.0.50');
  assert.equal(reg.port, 5432);
  assert.equal(reg.user, 'dbadmin');
  assert.equal(reg.mode, 'external');

  const record = bindProjectDbs(cfg, 'analytics', {
    postgresql: "postgresql://app_user:p'inject@10.0.0.50:5432/analytics_db",
    redis: 'redis://:redis_pass@10.0.0.51:6379/2',
  });
  assert.equal(record.databases.postgresql.database, 'analytics_db');
  assert.equal(record.databases.postgresql.username, 'app_user');
  assert.equal(record.databases.postgresql.bound, true);
  assert.equal(record.databases.redis.keyPrefix, 'analytics:*');
  const provisioned = provisionProjectDbs(cfg, 'analytics', ['postgresql', 'redis']);
  assert.equal(provisioned.databases.postgresql.url, "postgresql://app_user:p'inject@10.0.0.50:5432/analytics_db");
  const envOut = formatDbEnv(record);
  assert.match(envOut, /POSTGRES_URL="postgresql:\/\/app_user:p'inject@10\.0\.0\.50:5432\/analytics_db"/);
  assert.match(envOut, /REDIS_URL="redis:\/\/:redis_pass@10\.0\.0\.51:6379\/2"/);
});

test('supports dedicated-port and dedicated-chain gateway strategies and side-by-side DB ports', async (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-coexist-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgFile = path.join(dir, 'vibedock.config.json');
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      serverHost: '192.168.1.10',
      primaryDomain: '192.168.1.10.nip.io',
      domainMode: 'nip',
      gateway: 'caddy',
      gatewayStrategy: 'dedicated-port',
      gatewayHttpPort: 8080,
      gatewayHttpsPort: 8443,
      paths: {
        dataDir: dir,
        appsDir: path.join(dir, 'apps'),
        caddyConfig: path.join(dir, 'nonexistent-caddyfile'),
        caddySitesDir: path.join(dir, 'caddy/sites'),
        dbSecretsDir: path.join(dir, 'secrets/databases'),
      },
    }),
  );
  fs.mkdirSync(path.join(dir, 'secrets/databases'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'secrets/databases/admin.json'),
    JSON.stringify({
      postgresql: { host: '127.0.0.1', port: 45432, user: 'postgres', password: 'pw', mode: 'docker' },
      redis: { host: '127.0.0.1', port: 46379, password: 'pw', mode: 'docker' },
    }),
  );

  const cfg = loadVibeDockConfig(cfgFile);
  const res = publishApp(cfg, {
    id: 'coexist-demo',
    name: '并存演示应用',
    owner: 'SRE',
    description: '并存演示应用',
    components: [{ id: 'upstream', kind: 'external', upstream: 'http://127.0.0.1:18080' }],
  });
  assert.deepEqual(res.urls, ['http://team-coexist-demo.192.168.1.10.nip.io:8080']);

  const catalogPath = path.join(dir, 'catalog.json');
  const svc = createCatalogService(JSON.parse(fs.readFileSync(catalogPath, 'utf8')), {
    catalogFile: catalogPath,
    checker: async (listener) => ({ online: listener.port === 45432 || listener.port === 18080 }),
  });
  const snap = await svc.snapshot();
  const pgInfo = snap.dx.databases.find((d) => d.id === 'postgresql');
  assert.equal(pgInfo.port, 45432);
  assert.equal(pgInfo.online, true);
  assert.match(pgInfo.exampleUrl, /:45432\//);
});

test('builds controlled start-service and activate commands and prunes expired database backups', (context) => {
  const skillCfg = {
    appsDir: '/var/lib/vibedock/apps',
    appPrefix: 'vibe-',
  };
  const nodeCmd = buildStartServiceRemoteCmd(skillCfg, {
    projectId: 'demo-app',
    release: '20261108-1200',
    component: 'api',
    runtime: 'node',
    entry: 'server.mjs',
    port: 40005,
  });
  assert.match(nodeCmd, /db\.env/);
  assert.match(nodeCmd, /PORT: String\(40005\)/);
  assert.match(nodeCmd, /const procName = "vibe-demo-app-api"/);
  assert.match(nodeCmd, /spawnSync\(.+pm2.+\[.+\bsave\b/);

  const pyCmd = buildStartServiceRemoteCmd(skillCfg, {
    projectId: 'demo-app',
    release: '20261108-1200',
    component: 'worker',
    runtime: 'python',
    entry: 'app.main:app',
    port: 40006,
  });
  assert.match(pyCmd, /const procName = "vibe-demo-app-worker"/);
  assert.match(pyCmd, /\.venv\/bin\/uvicorn/);

  const actCmd = buildActivateRemoteCmd(skillCfg, 'demo-app', '20261108-1200');
  assert.match(actCmd, /-sfn/);
  assert.match(actCmd, /"20261108-1200"/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-backup-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgFile = path.join(dir, 'vibedock.config.json');
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      paths: {
        dataDir: dir,
        dbSecretsDir: path.join(dir, 'secrets/databases'),
      },
    }),
  );
  const cfg = loadVibeDockConfig(cfgFile);
  bindProjectDbs(cfg, 'backup-demo', {
    postgresql: 'postgresql://u:p@127.0.0.1:59999/demo_db',
    mongodb: 'mongodb://u:p@127.0.0.1:59997/demo_mongo',
  });

  // Create an expired backup directory (10 days old)
  const expiredDir = path.join(dir, 'backups/databases/20200101-000000');
  fs.mkdirSync(expiredDir, { recursive: true });
  const oldTime = new Date(Date.now() - 10 * 86400 * 1000);
  fs.utimesSync(expiredDir, oldTime, oldTime);

  const rawBinaryBytes = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xfe]);
  const backupRes = backupProjectDbs(cfg, {
    project: 'backup-demo',
    keepDays: 7,
    dumper: (proj, engine, entry) =>
      engine === 'mongodb' ? rawBinaryBytes : `-- dump for ${proj} ${engine} ${entry.database}\n`,
  });
  assert.equal(backupRes.ok, true);
  assert.equal(backupRes.files.length, 2);
  const pgFile = backupRes.files.find((f) => f.endsWith('.sql'));
  const mongoFile = backupRes.files.find((f) => f.endsWith('.archive'));
  assert.match(fs.readFileSync(pgFile, 'utf8'), /-- dump for backup-demo postgresql demo_db/);
  assert.deepEqual(fs.readFileSync(mongoFile), rawBinaryBytes);
  assert.ok(fs.existsSync(path.join(backupRes.backupDir, 'manifest.json')));
  assert.deepEqual(backupRes.prunedDirs, [expiredDir]);
  assert.equal(fs.existsSync(expiredDir), false);

  // Unreachable Redis backup must fail instead of returning fake metadata
  bindProjectDbs(cfg, 'redis-fail-demo', {
    redis: 'redis://:pass@127.0.0.1:59996/0',
  });
  const redisFailRes = backupProjectDbs(cfg, { project: 'redis-fail-demo' });
  assert.equal(redisFailRes.ok, false);
  assert.equal(redisFailRes.errors.length, 1);
  assert.equal(redisFailRes.errors[0].engine, 'redis');
});
