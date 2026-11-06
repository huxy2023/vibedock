import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAiConfigService, sanitizeDraft } from '../dist/services/ai-config.js';

test('validates provider URLs and rejects secrets in URL parameters', () => {
  assert.throws(
    () =>
      sanitizeDraft({
        enabled: true,
        provider: 'custom',
        model: 'test',
        apiUrl: 'https://example.com/v1/chat/completions?api_key=secret',
        apiStyle: 'chat-completions',
      }),
    /不能放在 URL/,
  );
  assert.throws(
    () =>
      sanitizeDraft({
        enabled: true,
        provider: 'custom',
        model: 'test',
        apiUrl: 'https://example.com/v1/chat/completions',
        apiStyle: 'chat-completions',
        allowNoKey: true,
      }),
    /仅适用于本机或私网/,
  );
});

test('atomically saves a redacted config, audits it, and tests the connection', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-ai-config-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'ai.json');
  const keyFile = path.join(directory, 'ai.key');
  const auditFile = path.join(directory, 'audit.jsonl');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: false, provider: 'deepseek' }), { mode: 0o600 });
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const service = createAiConfigService({ configFile, keyFile, auditFile });
  const draft = {
    enabled: true,
    provider: 'custom',
    model: 'local-model',
    apiUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    apiStyle: 'chat-completions',
    apiKey: 'super-secret-key',
  };
  const saved = await service.save(draft, { actor: 'test' });
  assert.equal(saved.enabled, true);
  assert.equal(saved.hasApiKey, true);
  assert.equal(Object.hasOwn(saved, 'apiKey'), false);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), 'super-secret-key');
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(configFile, 'utf8'), /super-secret-key/);
  assert.doesNotMatch(fs.readFileSync(auditFile, 'utf8'), /super-secret-key/);

  const tested = await service.testConnection({ ...draft, apiKey: '' }, { actor: 'test' });
  assert.equal(tested.ok, true);
  assert.equal(tested.response, 'OK');
});

test('does not reuse a key silently when switching enabled providers', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-ai-switch-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'ai.json');
  const keyFile = path.join(directory, 'ai.key');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKeyFile: keyFile,
    }),
  );
  fs.writeFileSync(keyFile, 'old-provider-key');
  const service = createAiConfigService({ configFile, keyFile });
  await assert.rejects(
    service.save({
      enabled: true,
      provider: 'openai',
      model: 'gpt-test',
    }),
    /必须填写新的 API Key/,
  );
});
