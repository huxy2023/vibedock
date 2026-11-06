import { Hono } from 'hono';
import type { AgentService } from '../services/assistant/agent.js';
import type { HistoryService } from '../services/history.js';
import {
  clientActor,
  createRateLimiter,
  readJsonBody,
  requireAuth,
  type AppEnv,
} from './middleware.js';

export interface AssistantRouteDeps {
  agentService: AgentService;
  historyService: HistoryService;
}

export function createAssistantRoutes(deps: AssistantRouteDeps): Hono<AppEnv> {
  const { agentService, historyService } = deps;
  const router = new Hono<AppEnv>();
  const assistantRateLimit = createRateLimiter({ windowMs: 60_000, limit: 20 });
  const actionRateLimit = createRateLimiter({ windowMs: 60_000, limit: 12 });

  router.post('/agent-runs', assistantRateLimit, requireAuth, async (c) => {
    const user = c.get('user')!;
    const isAdmin = user.role === 'admin';
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    const result = agentService.start({
      ownerId: user.id,
      actor: clientActor(c),
      role: isAdmin ? 'admin' : 'member',
      question: body.question,
      conversationId: body.conversationId ? String(body.conversationId) : '',
      permission: isAdmin ? body.permission : 'read',
      projectIds: body.projectIds,
    });
    return c.json(result, 202);
  });

  router.get('/agent-runs/:runId/events', requireAuth, (c) => {
    const user = c.get('user')!;
    const runId = c.req.param('runId');
    if (!historyService.getAgentRun(user.id, runId)) {
      return c.json({ error: 'Agent 运行不存在' }, 404);
    }

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'));
        unsubscribe = agentService.subscribe(user.id, runId, (event) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
            if (['final', 'error', 'cancelled'].includes(event.type)) {
              setImmediate(() => {
                try {
                  unsubscribe?.();
                  controller.close();
                } catch {
                  // Ignore if already closed
                }
              });
            }
          } catch {
            unsubscribe?.();
          }
        });
      },
      cancel() {
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  router.post('/agent-runs/:runId/cancel', actionRateLimit, requireAuth, (c) => {
    const user = c.get('user')!;
    c.header('Cache-Control', 'no-store');
    return c.json(agentService.cancel(user.id, c.req.param('runId')), 202);
  });

  router.get('/conversations', requireAuth, (c) => {
    const user = c.get('user')!;
    c.header('Cache-Control', 'no-store');
    return c.json({ conversations: historyService.listConversations(user.id) });
  });

  router.post('/conversations', actionRateLimit, requireAuth, async (c) => {
    const user = c.get('user')!;
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    return c.json(historyService.createConversation(user.id, String(body.title || '新会话')), 201);
  });

  router.get('/conversations/:conversationId', requireAuth, (c) => {
    const user = c.get('user')!;
    c.header('Cache-Control', 'no-store');
    return c.json(historyService.getConversation(user.id, c.req.param('conversationId')));
  });

  return router;
}
