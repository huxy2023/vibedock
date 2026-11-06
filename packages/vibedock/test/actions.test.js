import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildActionRegistry, createOperationsService } from '../dist/services/actions.js';
import { createCatalogService, loadAndValidateCatalog } from '../dist/services/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadAndValidateCatalog(path.join(__dirname, '..', 'data', 'catalog.json'));

test('builds only typed allowlisted actions and never offers a self restart', () => {
  const actions = [...buildActionRegistry(catalog).values()];
  assert.ok(actions.some((action) => action.kind === 'diagnose'));
  assert.ok(actions.some((action) => action.kind === 'logs'));
  assert.ok(actions.some((action) => action.kind === 'restart'));
  assert.equal(actions.some((action) => action.id === 'vibedock-portal:portal-web:restart'), false);
  for (const action of actions) {
    assert.match(action.id, /^[a-z0-9:-]+$/);
    assert.ok(['diagnose', 'exec'].includes(action.executor.type));
    assert.equal(action.executor.shell, undefined);
  }
});

test('keeps executor details private and audits executions without leaking output', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-actions-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auditFile = path.join(directory, 'audit.jsonl');
  const catalogService = createCatalogService(catalog, {
    cacheMs: 0,
    checker: async () => ({ online: true, checkedAt: '2026-08-10T00:00:00.000Z' }),
  });
  const service = createOperationsService(catalog, catalogService, { auditFile });

  assert.equal(service.list().some((action) => Object.hasOwn(action, 'executor')), false);

  const result = await service.execute('team-demo-hub:diagnose', { actor: 'test' });
  assert.equal(result.status, 'succeeded');
  assert.match(result.output, /团队(示例工作台|演示看板)/);
  const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8').trim());
  assert.equal(audit.actionId, 'team-demo-hub:diagnose');
  assert.equal(Object.hasOwn(audit, 'output'), false);
});

test('requires confirmation and a reason for change actions', async () => {
  const catalogService = createCatalogService(catalog, { checker: async () => ({ online: true }) });
  const service = createOperationsService(catalog, catalogService);
  await assert.rejects(service.execute('team-demo-hub:api:restart', {}), /二次确认/);
  await assert.rejects(service.execute('team-demo-hub:api:restart', { confirmed: true }), /操作原因/);
});

test('registers status, logs, and restart actions for PM2 (vibe-deploy) team projects', () => {
  const actions = buildActionRegistry(catalog);
  assert.equal(actions.has('team-demo-hub:api:status'), true);
  assert.equal(actions.has('team-demo-hub:api:logs'), true);
  assert.equal(actions.has('team-demo-hub:api:restart'), true);
  assert.equal(actions.get('team-demo-hub:api:status').executor.binary, 'deployPm2');
});
