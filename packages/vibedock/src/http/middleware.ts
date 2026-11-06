import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AuthService } from '../services/auth.js';
import type { UserDto } from '../types.js';

export interface AppVariables {
  user: UserDto | null;
}

export interface AppEnv {
  Variables: AppVariables;
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  await next();
};

export function createAuthMiddleware(authService: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authHeader = c.req.header('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const cookieToken = getCookie(c, authService.COOKIE_NAME) || '';
    const rawToken = bearer || cookieToken;
    const user = authService.authenticate(rawToken);
    c.set('user', user);
    await next();
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: '请先登录内网应用门户', authRequired: true }, 401);
  }
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (user?.role !== 'admin') {
    return c.json(
      {
        error: user ? '该操作需要管理员权限' : '请先登录管理员账号',
        authRequired: !user,
      },
      user ? 403 : 401,
    );
  }
  await next();
};

export function setSessionCookie(c: Context<AppEnv>, authService: AuthService, token: string): void {
  const maxAge = Math.floor(authService.SESSION_TTL_MS / 1000);
  setCookie(c, authService.COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge,
  });
}

export function clearSessionCookie(c: Context<AppEnv>, authService: AuthService): void {
  deleteCookie(c, authService.COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
}

export function extractRawToken(c: Context<AppEnv>, authService: AuthService): string {
  const authHeader = c.req.header('authorization') || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  return getCookie(c, authService.COOKIE_NAME) || '';
}

export function clientActor(c: Context<AppEnv>): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.get('user')?.username || '127.0.0.1';
}

export async function readJsonBody<T = Record<string, any>>(c: Context<AppEnv>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function createRateLimiter({ windowMs, limit }: { windowMs: number; limit: number }): MiddlewareHandler<AppEnv> {
  const clients = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = Date.now();
    const key = clientActor(c);
    const current = clients.get(key);
    const record = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    record.count += 1;
    clients.set(key, record);
    if (clients.size > 500) {
      for (const [client, value] of clients) {
        if (value.resetAt <= now) clients.delete(client);
      }
    }
    if (record.count > limit) {
      c.header('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)));
      return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
    }
    await next();
  };
}
