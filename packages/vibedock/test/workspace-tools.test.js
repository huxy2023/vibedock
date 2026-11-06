import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceTools } from '../dist/services/assistant/tools.js';

test('workspace tools stay inside catalog projects and never auto-run change actions', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-workspace-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src', 'app.js'), 'const port = 39090;\nconsole.log(port);\n');
  fs.writeFileSync(path.join(directory, '.env'), 'API_KEY=secret\n');
  const outside = path.join(path.dirname(directory), `vibedock-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(directory, 'outside-link.txt'));
  context.after(() => fs.rmSync(outside, { force: true }));
  const catalog = { projects: [{ id: 'demo', name: 'Demo', projectPath: directory }] };
  const executed = [];
  const actions = [
    { id: 'demo:web:status', projectId: 'demo', label: '状态', command: 'pm2 describe demo', risk: 'read', kind: 'status' },
    { id: 'demo:web:restart', projectId: 'demo', label: '重启', command: 'pm2 restart demo', risk: 'change', kind: 'restart' },
  ];
  const operationsService = {
    list: () => actions,
    execute: async (actionId) => {
      executed.push(actionId);
      return { status: 'succeeded', output: 'online' };
    },
  };
  const tools = createWorkspaceTools({ catalog, operationsService });

  const listed = await tools.execute('list_project_files', { projectId: 'demo' }, { projectIds: ['demo'], permission: 'read' });
  assert.deepEqual(listed.files, ['src/app.js']);
  const read = await tools.execute(
    'read_project_file',
    { projectId: 'demo', relativePath: 'src/app.js' },
    { projectIds: ['demo'], permission: 'read' },
  );
  assert.match(read.content, /39090/);
  const searched = await tools.execute(
    'search_project_code',
    { projectId: 'demo', query: 'console.log' },
    { projectIds: ['demo'], permission: 'read' },
  );
  assert.equal(searched.matches[0].line, 2);
  await assert.rejects(
    tools.execute('read_project_file', { projectId: 'demo', relativePath: '../outside.txt' }, { projectIds: ['demo'], permission: 'read' }),
    /不允许|超出/,
  );
  await assert.rejects(
    tools.execute('read_project_file', { projectId: 'demo', relativePath: '.env' }, { projectIds: ['demo'], permission: 'read' }),
    /不允许/,
  );
  await assert.rejects(
    tools.execute('read_project_file', { projectId: 'demo', relativePath: 'outside-link.txt' }, { projectIds: ['demo'], permission: 'read' }),
    /符号链接/,
  );

  const proposal = await tools.execute('run_service_action', { actionId: 'demo:web:restart' }, { projectIds: ['demo'], permission: 'change' });
  assert.equal(proposal.approvalRequired, true);
  assert.deepEqual(executed, []);
  await tools.execute('run_service_action', { actionId: 'demo:web:status' }, { projectIds: ['demo'], permission: 'read' });
  assert.deepEqual(executed, ['demo:web:status']);
});
