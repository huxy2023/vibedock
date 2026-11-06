import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadVibeDockConfig } from '../dist/config.js';
import { createOperationsService } from '../dist/services/actions.js';
import { createAiConfigService } from '../dist/services/ai-config.js';
import { createAgentService } from '../dist/services/assistant/agent.js';
import { createWorkspaceTools } from '../dist/services/assistant/tools.js';
import { createAuthService } from '../dist/services/auth.js';
import { createCatalogService, loadAndValidateCatalog } from '../dist/services/catalog.js';
import { createHistoryService } from '../dist/services/history.js';

test('Hono HTTP layer handles auth, catalog, SSE agent runs, and static assets', async (context) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-http-'));
  context.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const vibeConfig = loadVibeDockConfig();
  vibeConfig.auth.defaultAdminPassword = 'admin-password';
  vibeConfig.auth.defaultMemberPassword = 'member-password';
  vibeConfig.auth.defaultInviteCode = 'invite-code';
  const catalogFile = path.join(vibeConfig.paths.dataDir, 'catalog.json');

  const { app, close } = createApp({
    vibeConfig,
    catalogFile,
    authDbFile: path.join(tmpDir, 'auth.sqlite3'),
    chatDbFile: path.join(tmpDir, 'chat.sqlite3'),
    aiConfigFile: path.join(tmpDir, 'ai.json'),
    aiKeyFile: path.join(tmpDir, 'ai.key'),
    auditFile: path.join(tmpDir, 'audit.jsonl'),
  });
  context.after(() => close());

  // 1. Health check
  const healthRes = await app.request('/api/health');
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), { status: 'ok' });

  // 2. Unauthenticated catalog returns 401
  const unauthRes = await app.request('/api/catalog');
  assert.equal(unauthRes.status, 401);

  // 3. Login as admin
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
  });
  assert.equal(loginRes.status, 200);
  const { token, user } = await loginRes.json();
  assert.equal(user.role, 'admin');
  assert.ok(token);

  const authHeaders = { Authorization: `Bearer ${token}` };

  // 4. Authenticated catalog returns projects + admin actions
  const catRes = await app.request('/api/catalog', { headers: authHeaders });
  assert.equal(catRes.status, 200);
  const catData = await catRes.json();
  assert.ok(Array.isArray(catData.projects));
  assert.ok(catData.actions.length > 0);

  // 5. Start an Agent Run and read SSE stream until final event
  const runRes = await app.request('/api/assistant/agent-runs', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '检查当前所有服务的在线状态' }),
  });
  assert.equal(runRes.status, 202);
  const runData = await runRes.json();
  assert.ok(runData.agentRun?.id);

  const sseRes = await app.request(`/api/assistant/agent-runs/${runData.agentRun.id}/events`, {
    headers: authHeaders,
  });
  assert.equal(sseRes.status, 200);
  const sseText = await sseRes.text();
  assert.match(sseText, /event: final/);

  // 6. Serve static index.html and Vite-bundled React assets
  const htmlRes = await app.request('/');
  assert.equal(htmlRes.status, 200);
  const htmlText = await htmlRes.text();
  assert.match(htmlText, /id="root"/);
  const assetMatch = htmlText.match(/src="(\/assets\/[^"]+\.js)"/);
  assert.ok(assetMatch, 'Expected Vite JS bundle script tag in index.html');

  const jsRes = await app.request(assetMatch[1]);
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type') || '', /javascript/);

  // 7. Direct static access to .zip files is blocked (prevents bypassing /api/dx/skill-package auth)
  const zipBypassRes = await app.request('/vibedock-deploy.zip');
  assert.equal(zipBypassRes.status, 404);
});

test('DX manifest contract, publishApp rollback, and withFileLock mutual exclusion', async (context) => {
  const { publishApp } = await import('../dist/deploy/publish.js');
  const { withFileLock } = await import('../dist/deploy/utils.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-publish-'));
  context.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const dataDir = path.join(tmpDir, 'data');
  const appsDir = path.join(tmpDir, 'apps');
  const sitesDir = path.join(tmpDir, 'sites');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sitesDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify({ projects: [] }, null, 2));

  const cfg = loadVibeDockConfig();
  cfg.paths.dataDir = dataDir;
  cfg.paths.appsDir = appsDir;
  cfg.paths.caddySitesDir = sitesDir;
  cfg.paths.caddyConfig = path.join(tmpDir, 'Caddyfile');

  // 1. DX generated manifest uses `name` and can be published directly
  const projectId = 'demo-app';
  const manifest = {
    id: projectId,
    name: '团队新应用',
    category: '工具',
    owner: 'Team',
    description: '团队新应用（通过 VibeDock 自动接入）',
    components: [{ id: 'web', kind: 'static', root: 'web' }],
    routes: [{ path: '/*', component: 'web' }],
  };
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0);

  const webRoot = path.join(appsDir, projectId, 'current', 'web');
  fs.mkdirSync(webRoot, { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<h1>Hello</h1>');

  const pubRes = publishApp(cfg, manifest, { skipPortCheck: true, skipCaddyReload: true });
  assert.equal(pubRes.projectId, `team-${projectId}`);
  assert.ok(fs.existsSync(pubRes.siteFile));

  // 2. Failed republish preserves existing working Caddy site config
  const workingConfig = fs.readFileSync(pubRes.siteFile, 'utf8');
  fs.writeFileSync(cfg.paths.caddyConfig, '# mock Caddyfile\n');
  cfg.paths.caddyBin = '/usr/bin/false';
  assert.throws(() => {
    publishApp(cfg, { ...manifest, description: 'broken update' }, { skipPortCheck: true });
  }, /Caddy validate failed/);
  assert.equal(fs.readFileSync(pubRes.siteFile, 'utf8'), workingConfig);

  // 2b. Rejects Caddyfile directive injection in route.path or route.subdomain
  assert.throws(() => {
    publishApp(
      cfg,
      {
        ...manifest,
        routes: [{ path: '/api/*\n}\nreverse_proxy 127.0.0.1:2019 {\n', component: 'web' }],
      },
      { skipPortCheck: true, skipCaddyReload: true },
    );
  }, /Invalid route path/);

  assert.throws(() => {
    publishApp(
      cfg,
      {
        ...manifest,
        routes: [{ path: '/*', host: 'sub', subdomain: 'bad\nhost', component: 'web' }],
      },
      { skipPortCheck: true, skipCaddyReload: true },
    );
  }, /Invalid route subdomain/);

  assert.throws(() => {
    publishApp(
      cfg,
      {
        ...manifest,
        components: [{ id: 'web', kind: 'static', root: 'web\nreverse_proxy 127.0.0.1:2019' }],
      },
      { skipPortCheck: true, skipCaddyReload: true },
    );
  }, /Invalid static root path/);

  // 3. withFileLock prevents concurrent/re-entrant lock acquisition
  const lockFile = path.join(dataDir, 'publish.lock');
  withFileLock(lockFile, () => {
    assert.throws(
      () => withFileLock(lockFile, () => 'nested', { timeoutMs: 50 }),
      /Lock is already held|Timed out waiting for lock/,
    );
  });
});
