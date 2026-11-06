import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deterministicAnswer } from '../dist/services/assistant/fallback.js';
import {
  extractChatText,
  extractModelReply,
  extractOutputText,
  modelFailureReason,
  resolveProviderConfig,
} from '../dist/services/assistant/provider.js';

function snapshot() {
  return {
    summary: { projects: 1, components: 2, listeners: 2, onlineListeners: 2, ingressRules: 2 },
    projects: [
      {
        id: 'shop',
        name: '商城',
        shortName: 'shop',
        aliases: ['购物站'],
        status: 'online',
        tags: ['Web'],
        components: [
          {
            id: 'web',
            name: '前端',
            role: '页面',
            online: true,
            listeners: [{ protocol: 'http', host: '127.0.0.1', port: 3100, online: true }],
          },
          {
            id: 'api',
            name: '后端',
            role: '接口',
            online: true,
            listeners: [{ protocol: 'http', host: '127.0.0.1', port: 8100, online: true }],
          },
        ],
        ingressRules: [
          {
            name: '页面',
            match: { protocol: 'http', hosts: ['shop.vibe.example.com'], paths: ['/*'] },
            target: { component: 'web', listener: 'http' },
          },
          {
            name: '接口',
            match: { protocol: 'http', hosts: ['shop.vibe.example.com'], paths: ['/api/*'] },
            target: { component: 'api', listener: 'http' },
          },
        ],
      },
    ],
  };
}

test('answers port ownership from the catalog without pretending to use a model', () => {
  const result = deterministicAnswer(snapshot(), '商城前端和后端用了哪些端口？', [
    { id: 'shop:diagnose', projectId: 'shop', kind: 'diagnose' },
  ]);
  assert.equal(result.mode, 'catalog');
  assert.match(result.answer, /前端: 127\.0\.0\.1:3100/);
  assert.match(result.answer, /后端: 127\.0\.0\.1:8100/);
});

test('uses explicit project aliases before broad keyword matching', () => {
  const result = deterministicAnswer(snapshot(), '购物站的域名、路径和端口是什么？', []);
  assert.deepEqual(result.projectIds, ['shop']);
  assert.match(result.answer, /前端: 127\.0\.0\.1:3100/);
  assert.match(result.answer, /shop\.vibe\.example\.com\/api\/\*/);
});

test('keeps status diagnosis and action suggestions scoped to an explicitly named project', () => {
  const actions = [
    { id: 'shop:status', projectId: 'shop', kind: 'status' },
    { id: 'other:status', projectId: 'other', kind: 'status' },
  ];
  const result = deterministicAnswer(snapshot(), '购物站现在状态怎么样？', actions);
  assert.deepEqual(result.projectIds, ['shop']);
  assert.deepEqual(result.suggestions, ['shop:status']);
  assert.doesNotMatch(result.answer, /other/);
});

test('reads Responses and Chat Completions output shapes', () => {
  assert.equal(extractOutputText({ output_text: 'hello' }), 'hello');
  assert.equal(extractChatText({ choices: [{ message: { content: 'world' } }] }), 'world');
});

test('turns provider failures into safe user-facing reasons', () => {
  assert.equal(modelFailureReason(new Error('DeepSeek API returned no text (finish=length)')), '模型输出达到长度上限');
  assert.equal(modelFailureReason(new Error('DeepSeek API HTTP 429')), '模型接口返回 HTTP 429');
  assert.equal(modelFailureReason(Object.assign(new Error('aborted'), { name: 'AbortError' })), '请求超时');
  assert.equal(modelFailureReason(new Error('secret backend detail')), '模型服务响应异常');
});

test('accepts only registered structured action proposals from model JSON', () => {
  const parsed = extractModelReply(
    JSON.stringify({
      markdown: '## 结论\n建议先查看状态。',
      actionIds: ['shop:status', 'arbitrary:shell'],
      actionReasons: { 'shop:status': '确认进程是否在线', 'arbitrary:shell': '运行任意命令' },
    }),
    [{ id: 'shop:status' }],
  );
  assert.match(parsed.markdown, /## 结论/);
  assert.deepEqual(parsed.actionIds, ['shop:status']);
  assert.deepEqual(parsed.actionReasons, { 'shop:status': '确认进程是否在线' });
});

test('loads a DeepSeek preset from private files and blocks cleartext external URLs', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-ai-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'ai.key');
  const configFile = path.join(directory, 'ai.json');
  fs.writeFileSync(keyFile, 'secret\n', { mode: 0o600 });
  fs.writeFileSync(
    configFile,
    JSON.stringify({ enabled: true, provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyFile: keyFile }),
  );
  const configured = resolveProviderConfig(configFile);
  assert.equal(configured.enabled, true);
  assert.equal(configured.apiStyle, 'chat-completions');
  assert.equal(configured.apiUrl, 'https://api.deepseek.com/chat/completions');

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      enabled: true,
      provider: 'custom',
      model: 'test',
      apiUrl: 'http://example.com/v1/chat/completions',
      apiKeyFile: keyFile,
    }),
  );
  const insecure = resolveProviderConfig(configFile);
  assert.equal(insecure.enabled, false);
  assert.match(insecure.configError, /必须使用 HTTPS/);
});
