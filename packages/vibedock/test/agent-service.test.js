import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentService } from '../dist/services/assistant/agent.js';
import { createHistoryService } from '../dist/services/history.js';

function response(payload) {
  return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
}

test('agent dynamically executes model-selected tools and persists live steps', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-agent-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'ai.json');
  const keyFile = path.join(directory, 'ai.key');
  fs.writeFileSync(keyFile, 'test-key');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      enabled: true,
      provider: 'deepseek',
      model: 'test-model',
      apiUrl: 'https://api.example.com/chat/completions',
      apiStyle: 'chat-completions',
      apiKeyFile: keyFile,
    }),
  );
  const history = createHistoryService({ databaseFile: path.join(directory, 'history.sqlite3') });
  context.after(() => history.close());
  const calls = [];
  const fetchMock = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length === 1) {
      return response({
        choices: [
          {
            message: {
              content: null,
              tool_calls: Array.from({ length: 6 }, (_, index) => ({
                id: `call-${index + 1}`,
                type: 'function',
                function: { name: 'run_service_action', arguments: '{"actionId":"demo:web:status"}' },
              })),
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }
    return response({
      choices: [
        {
          message: {
            content: 'I have enough evidence.\n\n{"markdown":"## 结论\\n服务在线。","actionIds":[],"actionReasons":{}}',
          },
          finish_reason: 'stop',
        },
      ],
    });
  };
  const catalog = {
    projects: [{ id: 'demo', name: 'Demo', description: '', projectPath: directory, status: 'online', components: [], ingressRules: [] }],
  };
  const actions = [{ id: 'demo:web:status', projectId: 'demo', label: '服务状态', command: 'pm2 describe demo', risk: 'read', kind: 'status' }];
  const operationsService = { list: () => actions };
  const workspaceTools = {
    definitions: () => [
      {
        type: 'function',
        name: 'run_service_action',
        description: 'status',
        parameters: { type: 'object', properties: { actionId: { type: 'string' } }, required: ['actionId'], additionalProperties: false },
        strict: true,
      },
    ],
    label: () => '服务状态',
    execute: async () => ({ actionId: 'demo:web:status', status: 'succeeded', output: 'online' }),
  };
  const service = createAgentService({
    catalog,
    catalogService: { snapshot: async () => catalog, current: () => catalog },
    operationsService,
    historyService: history,
    workspaceTools,
    configFile,
    fetch: fetchMock,
  });
  const ownerId = 'user-admin';
  const started = service.start({ ownerId, actor: 'test', question: '检查 demo 状态', permission: 'read', projectIds: ['demo'] });
  const events = await new Promise((resolve, reject) => {
    const received = [];
    const timeout = setTimeout(() => reject(new Error('agent timeout')), 2_000);
    service.subscribe(ownerId, started.agentRun.id, (event) => {
      received.push(event);
      if (event.type === 'final') {
        clearTimeout(timeout);
        resolve(received);
      }
    });
  });
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[1], 'tools'), false);
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.match(calls[1].messages.at(-1).content, /online/);
  const final = events.at(-1);
  assert.equal(final.agentRun.status, 'succeeded');
  assert.deepEqual(
    final.agentRun.steps.map((step) => step.type),
    ['plan', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'synthesis'],
  );
  assert.match(final.assistantMessage.markdown, /服务在线/);
});
