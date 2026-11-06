import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function now(): string {
  return new Date().toISOString();
}

function truncate(value: unknown, limit: number): string {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n…内容已截断`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

export interface AgentStepDto {
  id: string;
  ordinal: number;
  type: 'plan' | 'tool' | 'synthesis';
  title: string;
  actionId: string | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  outputExcerpt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentRunDto {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  mode: 'ask' | 'diagnose' | 'repair';
  goal: string;
  status: 'planning' | 'running' | 'succeeded' | 'failed';
  stepLimit: number;
  context: Record<string, any>;
  summary: string | null;
  createdAt: string;
  completedAt: string | null;
  steps: AgentStepDto[];
}

export function createHistoryService(options: { databaseFile: string }) {
  const { databaseFile } = options;
  if (!databaseFile) throw new Error('CHAT_DB_FILE is required');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  if (databaseFile !== ':memory:' && !fs.existsSync(databaseFile)) {
    fs.writeFileSync(databaseFile, '', { mode: 0o600 });
  }
  const database = new DatabaseSync(databaseFile, { timeout: 5_000 });
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (databaseFile !== ':memory:') {
    for (const f of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
     }
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS conversations_owner_updated
      ON conversations(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      markdown TEXT NOT NULL,
      provider_label TEXT,
      notice TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS messages_conversation_created
      ON messages(conversation_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS message_actions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      reason TEXT,
      ordinal INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS message_actions_message
      ON message_actions(message_id, ordinal ASC);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      mode TEXT NOT NULL CHECK(mode IN ('ask', 'diagnose', 'repair')),
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('planning', 'running', 'succeeded', 'failed')),
      step_limit INTEGER NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      summary TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_runs_conversation_created
      ON agent_runs(conversation_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS agent_steps (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('plan', 'tool', 'synthesis')),
      title TEXT NOT NULL,
      action_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
      output_excerpt TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(agent_run_id, ordinal)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_steps_run_ordinal
      ON agent_steps(agent_run_id, ordinal ASC);
  `);

  database.prepare("UPDATE agent_runs SET status = 'failed', summary = '服务重启导致 Agent 运行中断', completed_at = ? WHERE status IN ('planning', 'running')").run(now());
  database.prepare("UPDATE agent_steps SET status = 'failed', output_excerpt = '服务重启导致步骤中断', completed_at = ? WHERE status = 'running'").run(now());
  fs.chmodSync(databaseFile, 0o600);

  const insertConversation = database.prepare('INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const ownedConversation = database.prepare('SELECT * FROM conversations WHERE id = ? AND owner_id = ? AND archived_at IS NULL');
  const insertMessage = database.prepare('INSERT INTO messages (id, conversation_id, role, markdown, provider_label, notice, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertMessageAction = database.prepare('INSERT INTO message_actions (id, message_id, action_id, reason, ordinal) VALUES (?, ?, ?, ?, ?)');
  const touchConversation = database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');

  function requireConversation(ownerId: string, conversationId: string) {
    const conversation = ownedConversation.get(conversationId, ownerId) as Record<string, any> | undefined;
    if (!conversation) {
      throw Object.assign(new Error('会话不存在或不属于当前账号'), { status: 404 });
    }
    return conversation;
  }

  function createConversation(ownerId: string, title = '新会话') {
    const id = crypto.randomUUID();
    const timestamp = now();
    const cleanTitle = truncate(title.trim() || '新会话', 80);
    insertConversation.run(id, ownerId, cleanTitle, timestamp, timestamp);
    return { id, ownerId, title: cleanTitle, createdAt: timestamp, updatedAt: timestamp };
  }

  function listConversations(ownerId: string, limit = 40) {
    const rows = database.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at,
        COUNT(m.id) AS message_count,
        COALESCE((SELECT markdown FROM messages lm WHERE lm.conversation_id = c.id ORDER BY lm.created_at DESC LIMIT 1), '') AS last_message
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.owner_id = ? AND c.archived_at IS NULL
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(ownerId, Math.max(1, Math.min(Number(limit) || 40, 100))) as Array<Record<string, any>>;

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messageCount: Number(row.message_count),
      lastMessage: truncate(row.last_message, 120),
    }));
  }

  function addMessage(input: {
    ownerId: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    markdown: string;
    providerLabel?: string | null;
    notice?: string | null;
    agentMode?: string;
    degraded?: boolean;
    actionIds?: string[];
    actionReasons?: Record<string, string>;
  }) {
    requireConversation(input.ownerId, input.conversationId);
    const id = crypto.randomUUID();
    const timestamp = now();
    const markdown = truncate(input.markdown, 60_000);
    const actionReasons = input.actionReasons || {};
    const metadata = {
      agentMode: input.agentMode,
      degraded: input.degraded === true,
      actionReasons,
    };
    const actionIds = [...new Set(input.actionIds || [])].slice(0, 8);

    database.exec('BEGIN IMMEDIATE');
    try {
      insertMessage.run(id, input.conversationId, input.role, markdown, input.providerLabel || null, input.notice || null, JSON.stringify(metadata), timestamp);
      actionIds.forEach((actionId, index) => {
        insertMessageAction.run(crypto.randomUUID(), id, actionId, actionReasons[actionId] || null, index);
      });
      touchConversation.run(timestamp, input.conversationId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      markdown,
      providerLabel: input.providerLabel || null,
      notice: input.notice || null,
      metadata,
      actionIds,
      actionReasons,
      agentRun: null as AgentRunDto | null,
      createdAt: timestamp,
    };
  }

  function publicAgentStep(step: Record<string, any>): AgentStepDto {
    return {
      id: String(step.id),
      ordinal: Number(step.ordinal),
      type: step.type,
      title: String(step.title),
      actionId: step.action_id ? String(step.action_id) : null,
      status: step.status,
      outputExcerpt: String(step.output_excerpt || ''),
      startedAt: step.started_at ? String(step.started_at) : null,
      completedAt: step.completed_at ? String(step.completed_at) : null,
    };
  }

  function publicAgentRun(run: Record<string, any>, prefetchedSteps?: Array<Record<string, any>>): AgentRunDto {
    const steps = prefetchedSteps
      ? prefetchedSteps.filter((step) => step.agent_run_id === run.id)
      : (database.prepare('SELECT * FROM agent_steps WHERE agent_run_id = ? ORDER BY ordinal ASC').all(run.id) as Array<Record<string, any>>);
    return {
      id: String(run.id),
      conversationId: String(run.conversation_id),
      userMessageId: String(run.user_message_id),
      assistantMessageId: run.assistant_message_id ? String(run.assistant_message_id) : null,
      mode: run.mode,
      goal: String(run.goal),
      status: run.status,
      stepLimit: Number(run.step_limit),
      context: parseJson(run.context_json, {}),
      summary: run.summary ? String(run.summary) : null,
      createdAt: String(run.created_at),
      completedAt: run.completed_at ? String(run.completed_at) : null,
      steps: steps.map(publicAgentStep),
    };
  }

  function getConversation(ownerId: string, conversationId: string) {
    const conversation = requireConversation(ownerId, conversationId);
    const messages = database.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as Array<Record<string, any>>;
    const actions = database.prepare(`
      SELECT ma.* FROM message_actions ma
      JOIN messages m ON m.id = ma.message_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC, ma.ordinal ASC
    `).all(conversationId) as Array<Record<string, any>>;
    const agentRuns = database.prepare('SELECT * FROM agent_runs WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at ASC').all(conversationId, ownerId) as Array<Record<string, any>>;
    const agentSteps = database.prepare(`
      SELECT s.* FROM agent_steps s
      JOIN agent_runs r ON r.id = s.agent_run_id
      WHERE r.conversation_id = ? AND r.owner_id = ?
      ORDER BY r.created_at ASC, s.ordinal ASC
    `).all(conversationId, ownerId) as Array<Record<string, any>>;

    return {
      id: String(conversation.id),
      title: String(conversation.title),
      createdAt: String(conversation.created_at),
      updatedAt: String(conversation.updated_at),
      messages: messages.map((message) => {
        const msgActions = actions.filter((a) => a.message_id === message.id);
        const actionIds = msgActions.map((a) => String(a.action_id));
        const actionReasons: Record<string, string> = {};
        for (const a of msgActions) {
          if (a.reason) actionReasons[String(a.action_id)] = String(a.reason);
        }
        const matchedRun = agentRuns.find((run) => run.assistant_message_id === message.id);
        return {
          id: String(message.id),
          conversationId,
          role: String(message.role),
          markdown: String(message.markdown),
          providerLabel: message.provider_label ? String(message.provider_label) : null,
          notice: message.notice ? String(message.notice) : null,
          metadata: parseJson(message.metadata_json, {}),
          actionIds,
          actionReasons,
          actions: msgActions.map((a) => ({ id: String(a.id), actionId: String(a.action_id), reason: a.reason ? String(a.reason) : null })),
          agentRun: matchedRun ? publicAgentRun(matchedRun, agentSteps) : null,
          createdAt: String(message.created_at),
        };
      }),
    };
  }

  function createAgentRun(input: {
    ownerId: string;
    conversationId: string;
    userMessageId: string;
    mode?: string;
    goal: string;
    stepLimit?: number;
    context?: Record<string, any>;
  }): AgentRunDto {
    requireConversation(input.ownerId, input.conversationId);
    const userMessage = database.prepare("SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'").get(input.userMessageId, input.conversationId);
    if (!userMessage) throw Object.assign(new Error('Agent 目标消息不存在或不属于当前会话'), { status: 404 });
    const mode = ['ask', 'diagnose', 'repair'].includes(input.mode || '') ? input.mode! : 'diagnose';
    const id = crypto.randomUUID();
    const timestamp = now();
    database.prepare(`
      INSERT INTO agent_runs (id, owner_id, conversation_id, user_message_id, mode, goal, status, step_limit, context_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?)
    `).run(id, input.ownerId, input.conversationId, input.userMessageId, mode, truncate(input.goal, 500), Math.max(1, Math.min(Number(input.stepLimit) || 8, 12)), JSON.stringify(input.context || {}), timestamp);
    return publicAgentRun(database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as Record<string, any>);
  }

  function addAgentStep(input: {
    ownerId: string;
    agentRunId: string;
    ordinal: number;
    type: 'plan' | 'tool' | 'synthesis';
    title: string;
    actionId?: string | null;
    status?: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
    outputExcerpt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
  }): AgentStepDto {
    const run = database.prepare('SELECT * FROM agent_runs WHERE id = ? AND owner_id = ?').get(input.agentRunId, input.ownerId) as Record<string, any> | undefined;
    if (!run) throw Object.assign(new Error('Agent 运行不存在'), { status: 404 });
    const id = crypto.randomUUID();
    database.prepare(`
      INSERT INTO agent_steps (id, agent_run_id, ordinal, type, title, action_id, status, output_excerpt, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, run.id, input.ordinal, input.type, truncate(input.title, 160), input.actionId || null, input.status || 'pending', truncate(input.outputExcerpt, 2_000), input.startedAt || null, input.completedAt || null);
    return publicAgentStep(database.prepare('SELECT * FROM agent_steps WHERE id = ?').get(id) as Record<string, any>);
  }

  function updateAgentStep(stepId: string, ownerId: string, patch: Partial<AgentStepDto>): AgentStepDto {
    const current = database.prepare(`
      SELECT s.* FROM agent_steps s JOIN agent_runs r ON r.id = s.agent_run_id
      WHERE s.id = ? AND r.owner_id = ?
    `).get(stepId, ownerId) as Record<string, any> | undefined;
    if (!current) throw Object.assign(new Error('Agent 步骤不存在'), { status: 404 });
    database.prepare(`UPDATE agent_steps SET status = ?, output_excerpt = ?, started_at = ?, completed_at = ? WHERE id = ?`)
      .run(
        patch.status || current.status,
        patch.outputExcerpt === undefined ? current.output_excerpt : truncate(patch.outputExcerpt, 2_000),
        patch.startedAt === undefined ? current.started_at : patch.startedAt,
        patch.completedAt === undefined ? current.completed_at : patch.completedAt,
        stepId,
      );
    return publicAgentStep(database.prepare('SELECT * FROM agent_steps WHERE id = ?').get(stepId) as Record<string, any>);
  }

  function updateAgentRun(runId: string, ownerId: string, patch: { status?: string; assistantMessageId?: string; summary?: string; completedAt?: string }): AgentRunDto {
    const current = database.prepare('SELECT * FROM agent_runs WHERE id = ? AND owner_id = ?').get(runId, ownerId) as Record<string, any> | undefined;
    if (!current) throw Object.assign(new Error('Agent 运行不存在'), { status: 404 });
    database.prepare(`UPDATE agent_runs SET status = ?, assistant_message_id = ?, summary = ?, completed_at = ? WHERE id = ?`)
      .run(
        patch.status || current.status,
        patch.assistantMessageId === undefined ? current.assistant_message_id : patch.assistantMessageId,
        patch.summary === undefined ? current.summary : truncate(patch.summary, 500),
        patch.completedAt === undefined ? current.completed_at : patch.completedAt,
        runId,
      );
    touchConversation.run(now(), current.conversation_id);
    return publicAgentRun(database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as Record<string, any>);
  }

  function getAgentRun(ownerId: string, runId: string): AgentRunDto | null {
    const run = database.prepare('SELECT * FROM agent_runs WHERE id = ? AND owner_id = ?').get(runId, ownerId) as Record<string, any> | undefined;
    return run ? publicAgentRun(run) : null;
  }

  function finishOpenAgentSteps(runId: string, ownerId: string, outputExcerpt = '任务已停止'): AgentRunDto | null {
    const run = database.prepare('SELECT id FROM agent_runs WHERE id = ? AND owner_id = ?').get(runId, ownerId);
    if (!run) throw Object.assign(new Error('Agent 运行不存在'), { status: 404 });
    const timestamp = now();
    database.prepare(`
      UPDATE agent_steps
      SET status = CASE WHEN status = 'running' THEN 'failed' ELSE 'skipped' END,
          output_excerpt = ?, completed_at = ?
      WHERE agent_run_id = ? AND status IN ('pending', 'running')
    `).run(truncate(outputExcerpt, 2_000), timestamp, runId);
    return getAgentRun(ownerId, runId);
  }

  function close(): void {
    database.close();
  }

  return {
    addAgentStep,
    addMessage,
    close,
    createAgentRun,
    createConversation,
    finishOpenAgentSteps,
    getAgentRun,
    getConversation,
    listConversations,
    requireConversation,
    updateAgentRun,
    updateAgentStep,
  };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
