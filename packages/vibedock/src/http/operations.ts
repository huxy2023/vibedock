import { Hono } from 'hono';
import type { OperationsService } from '../services/actions.js';
import type { AiConfigService } from '../services/ai-config.js';
import {
  clientActor,
  createRateLimiter,
  readJsonBody,
  requireAdmin,
  type AppEnv,
} from './middleware.js';

export interface OperationsRouteDeps {
  operationsService: OperationsService;
  aiConfigService: AiConfigService;
}

export function createOperationsRoutes(deps: OperationsRouteDeps): Hono<AppEnv> {
  const { operationsService, aiConfigService } = deps;
  const router = new Hono<AppEnv>();
  const actionRateLimit = createRateLimiter({ windowMs: 60_000, limit: 12 });

  router.get('/ai/config', actionRateLimit, requireAdmin, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(aiConfigService.current());
  });

  router.put('/ai/config', actionRateLimit, requireAdmin, async (c) => {
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    return c.json(await aiConfigService.save(body, { actor: clientActor(c) }));
  });

  router.post('/ai/config/test', actionRateLimit, requireAdmin, async (c) => {
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    return c.json(await aiConfigService.testConnection(body, { actor: clientActor(c) }));
  });

  router.post('/actions/:actionId/execute', actionRateLimit, requireAdmin, async (c) => {
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    return c.json(
      await operationsService.execute(c.req.param('actionId'), {
        confirmed: body.confirmed === true,
        reason: body.reason,
        actor: clientActor(c),
      }),
    );
  });

  return router;
}
