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
