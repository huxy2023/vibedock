import { Hono } from 'hono';
import type { AuthService } from '../services/auth.js';
import {
  clearSessionCookie,
  createRateLimiter,
  extractRawToken,
  readJsonBody,
  requireAdmin,
  requireAuth,
  setSessionCookie,
  type AppEnv,
} from './middleware.js';

export function createAuthRoutes(authService: AuthService): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const authRateLimit = createRateLimiter({ windowMs: 60_000, limit: 25 });
  const adminRateLimit = createRateLimiter({ windowMs: 60_000, limit: 12 });

  router.get('/session', (c) => {
    const user = c.get('user');
    c.header('Cache-Control', 'no-store');
    return c.json({
      authenticated: Boolean(user),
      user: user || null,
      registrationEnabled: Boolean(authService.getInviteCode()),
    });
  });

  router.post('/login', authRateLimit, async (c) => {
    const body = await readJsonBody(c);
    const { token, user } = authService.login(body.username, body.password);
    setSessionCookie(c, authService, token);
    c.header('Cache-Control', 'no-store');
    return c.json({ token, user });
  });

  router.post('/register', authRateLimit, async (c) => {
    const body = await readJsonBody(c);
    const { token, user } = authService.register({
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      inviteCode: body.inviteCode,
    });
    setSessionCookie(c, authService, token);
    c.header('Cache-Control', 'no-store');
    return c.json({ token, user }, 201);
  });

  router.post('/logout', (c) => {
    const rawToken = extractRawToken(c, authService);
    authService.logout(rawToken);
    clearSessionCookie(c, authService);
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true });
  });

  router.post('/password', authRateLimit, requireAuth, async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: '请先登录账号' }, 401);
    const body = await readJsonBody(c);
    const result = authService.changePassword(user.id, body.currentPassword, body.newPassword);
    if (result.token) setSessionCookie(c, authService, result.token);
    c.header('Cache-Control', 'no-store');
    return c.json({ updated: true });
  });

  router.get('/users', requireAdmin, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(authService.listUsers());
  });

  router.post('/users', adminRateLimit, requireAdmin, async (c) => {
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    return c.json({ user: authService.createUser(body) }, 201);
  });

  router.put('/users/:userId', adminRateLimit, requireAdmin, async (c) => {
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    return c.json({ user: authService.updateUser(c.req.param('userId'), body) });
  });

  router.delete('/users/:userId', adminRateLimit, requireAdmin, (c) => {
    const actor = c.get('user');
    c.header('Cache-Control', 'no-store');
    return c.json(authService.deleteUser(c.req.param('userId'), actor?.id));
  });

  router.put('/invite-code', adminRateLimit, requireAdmin, async (c) => {
    const body = await readJsonBody(c);
    c.header('Cache-Control', 'no-store');
    return c.json(authService.updateInviteCode(body.inviteCode));
  });

  return router;
}
