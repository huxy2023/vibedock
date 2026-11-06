import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHistoryService } from '../dist/services/history.js';

test('persists user-scoped conversations, action proposals, and agent runs in SQLite', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-history-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databaseFile = path.join(directory, 'history.sqlite3');
  const ownerId = 'user-admin';
  let history = createHistoryService({ databaseFile });
  const conversation = history.createConversation(ownerId, '排查客户服务');
  const userMessage = history.addMessage({
    ownerId,
    conversationId: conversation.id,
    role: 'user',
    markdown: '为什么接口失败？',
  });
  const agentRun = history.createAgentRun({
    ownerId,
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    mode: 'repair',
    goal: '修复接口失败',
    stepLimit: 4,
    context: { permission: 'change', projectIds: ['shop'] },
  });
  history.addAgentStep({
    ownerId,
    agentRunId: agentRun.id,
    ordinal: 0,
    type: 'plan',
    title: '先诊断后修复',
    status: 'succeeded',
  });
  const toolStep = history.addAgentStep({
    ownerId,
    agentRunId: agentRun.id,
    ordinal: 1,
    type: 'tool',
    title: '查看后端状态',
    actionId: 'shop:api:status',
  });
  history.updateAgentStep(toolStep.id, ownerId, {
    status: 'succeeded',
    outputExcerpt: 'online',
    completedAt: '2026-08-10T00:00:01.000Z',
  });
  const assistantMessage = history.addMessage({
    ownerId,
    conversationId: conversation.id,
    role: 'assistant',
    markdown: '## 结论\n连接被拒绝。',
    providerLabel: 'Test Model',
    actionIds: ['shop:api:status'],
    actionReasons: { 'shop:api:status': '确认进程状态' },
  });
  history.updateAgentRun(agentRun.id, ownerId, {
    status: 'succeeded',
    assistantMessageId: assistantMessage.id,
    summary: '已完成',
    completedAt: '2026-08-10T00:00:02.000Z',
  });
  history.close();

  history = createHistoryService({ databaseFile });
  context.after(() => history.close());
  const restored = history.getConversation(ownerId, conversation.id);
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].actions[0].actionId, 'shop:api:status');
  assert.equal(restored.messages[1].actions[0].reason, '确认进程状态');
  assert.equal(restored.messages[1].agentRun.mode, 'repair');
  assert.deepEqual(restored.messages[1].agentRun.context, { permission: 'change', projectIds: ['shop'] });
  assert.equal(restored.messages[1].agentRun.steps[1].actionId, 'shop:api:status');
  assert.equal(restored.messages[1].agentRun.steps[1].status, 'succeeded');
  assert.equal(history.listConversations(ownerId)[0].messageCount, 2);
  assert.throws(() => history.getConversation('other-user', conversation.id), /不属于当前账号/);
  assert.equal(fs.statSync(databaseFile).mode & 0o777, 0o600);
});
