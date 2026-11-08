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

test('Server MCP endpoint and HTTP upload backup path enforce deployToken auth and execute tools safely', async (context) => {
  const { spawnSync } = await import('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-mcp-'));
  context.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const dataDir = path.join(tmpDir, 'data');
  const appsDir = path.join(tmpDir, 'apps');
  const sitesDir = path.join(tmpDir, 'sites');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sitesDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify({ projects: [] }, null, 2));

  const cfg = loadVibeDockConfig();
  cfg.deployToken = 'vd_test_secret_token_123456';
  cfg.paths.dataDir = dataDir;
  cfg.paths.appsDir = appsDir;
  cfg.paths.caddySitesDir = sitesDir;
  cfg.paths.caddyConfig = path.join(tmpDir, 'nonexistent-Caddyfile');
  cfg.paths.dbSecretsDir = path.join(dataDir, 'secrets/databases');

  const { app, close } = createApp({
    vibeConfig: cfg,
    catalogFile: path.join(dataDir, 'catalog.json'),
    authDbFile: path.join(tmpDir, 'auth.sqlite3'),
    chatDbFile: path.join(tmpDir, 'chat.sqlite3'),
  });
  context.after(() => close());

  // 1. Rejects unauthenticated or wrong-token requests to /api/mcp and /api/dx/upload
  const unauthMcp = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong_token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  assert.equal(unauthMcp.status, 401);

  const unauthUpload = await app.request('/api/dx/upload?project=mcp-app&release=v1', {
    method: 'POST',
    body: Buffer.from('test'),
  });
  assert.equal(unauthUpload.status, 401);

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.deployToken}`,
  };

  // 2. MCP initialize & tools/list
  const initRes = await app.request('/api/mcp', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json();
  assert.equal(initBody.result.serverInfo.name, 'vibedock-mcp');

  const listRes = await app.request('/api/mcp', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const listBody = await listRes.json();
  const toolNames = listBody.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes('vibedock_alloc'));
  assert.ok(toolNames.includes('vibedock_db_bind'));
  assert.ok(toolNames.includes('vibedock_adopt'));
  assert.ok(toolNames.includes('vibedock_start_service'));

  // 3. MCP tools/call: vibedock_alloc, vibedock_db_bind (writes secrets/db.env), and vibedock_adopt
  const allocRes = await app.request('/api/mcp', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'vibedock_alloc', arguments: { projectId: 'mcp-app' } },
    }),
  });
  const allocBody = await allocRes.json();
  assert.equal(allocBody.result.structuredContent.projectId, 'team-mcp-app');
  assert.equal(allocBody.result.structuredContent.recommendedPort, 40000);

  const bindRes = await app.request('/api/mcp', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'vibedock_db_bind',
        arguments: {
          projectId: 'mcp-app',
          postgresql: 'postgresql://u:p@127.0.0.1:5432/mcp_db',
        },
      },
    }),
  });
  const bindBody = await bindRes.json();
  assert.equal(bindBody.result.structuredContent.ok, true);
  const dbEnvPath = path.join(appsDir, 'mcp-app', 'secrets', 'db.env');
  assert.ok(fs.existsSync(dbEnvPath));
  assert.match(fs.readFileSync(dbEnvPath, 'utf8'), /POSTGRES_URL="postgresql:\/\/u:p@127\.0\.0\.1:5432\/mcp_db"/);

  const adoptRes = await app.request('/api/mcp', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'vibedock_adopt',
        arguments: { id: 'mcp-app', upstream: 'http://127.0.0.1:18088', name: 'MCP Adopted Service' },
      },
    }),
  });
  const adoptBody = await adoptRes.json();
  assert.equal(adoptBody.result.structuredContent.projectId, 'team-mcp-app');

  // 4. HTTP upload backup path extracts tarball and rejects path traversal
  const traversalRes = await app.request('/api/dx/upload?project=mcp-app&release=v1&subpath=../../etc', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.deployToken}` },
    body: Buffer.from('bad'),
  });
  assert.equal(traversalRes.status, 400);

  const srcDir = path.join(tmpDir, 'src-web');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.html'), '<h1>Uploaded via HTTP</h1>');
  const tarFile = path.join(tmpDir, 'web.tar.gz');
  spawnSync('tar', ['-czf', tarFile, '-C', srcDir, '.']);

  const uploadRes = await app.request('/api/dx/upload?project=mcp-app&release=v1&subpath=web', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.deployToken}` },
    body: fs.readFileSync(tarFile),
  });
  assert.equal(uploadRes.status, 200);
  const extractedHtml = path.join(appsDir, 'mcp-app', 'releases', 'v1', 'web', 'index.html');
  assert.equal(fs.readFileSync(extractedHtml, 'utf8'), '<h1>Uploaded via HTTP</h1>');

  // 5. Rejects archives containing symbolic links and rejects symlink subpath escapes
  const symSrcDir = path.join(tmpDir, 'src-symlink');
  fs.mkdirSync(symSrcDir, { recursive: true });
  fs.symlinkSync(tmpDir, path.join(symSrcDir, 'jump'));
  const symTarFile = path.join(tmpDir, 'symlink.tar.gz');
  spawnSync('tar', ['-czf', symTarFile, '-C', symSrcDir, '.']);

  const symUploadRes = await app.request('/api/dx/upload?project=mcp-app&release=v1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.deployToken}` },
    body: fs.readFileSync(symTarFile),
  });
  assert.equal(symUploadRes.status, 400);

  fs.symlinkSync(tmpDir, path.join(appsDir, 'mcp-app', 'releases', 'v1', 'manual-jump'));
  const escapeSubpathRes = await app.request('/api/dx/upload?project=mcp-app&release=v1&subpath=manual-jump', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.deployToken}` },
    body: fs.readFileSync(tarFile),
  });
  assert.equal(escapeSubpathRes.status, 400);

  // Rejects when release directory itself is a symlink or destination file is a symlink
  fs.symlinkSync(tmpDir, path.join(appsDir, 'mcp-app', 'releases', 'v2-sym'));
  const symReleaseRes = await app.request('/api/dx/upload?project=mcp-app&release=v2-sym', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.deployToken}` },
    body: fs.readFileSync(tarFile),
  });
  assert.equal(symReleaseRes.status, 400);

  const outsideFile = path.join(tmpDir, 'outside-sentinel.txt');
  fs.writeFileSync(outsideFile, 'DO_NOT_OVERWRITE');
  const v3WebDir = path.join(appsDir, 'mcp-app', 'releases', 'v3', 'web');
  fs.mkdirSync(v3WebDir, { recursive: true });
  fs.symlinkSync(outsideFile, path.join(v3WebDir, 'index.html'));
  const symDestFileRes = await app.request('/api/dx/upload?project=mcp-app&release=v3&subpath=web', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.deployToken}` },
    body: fs.readFileSync(tarFile),
  });
  assert.equal(symDestFileRes.status, 400);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'DO_NOT_OVERWRITE');
});
