import fs from 'node:fs';
import { Hono } from 'hono';
import { getDbStatus } from '../deploy/databases.js';
import type { OperationsService } from '../services/actions.js';
import { assistantCapabilities } from '../services/assistant/provider.js';
import type { AuthService } from '../services/auth.js';
import { redactSnapshotForPublic, type CatalogService } from '../services/catalog.js';
import type { VibeDockConfig } from '../types.js';
import { requireAuth, type AppEnv } from './middleware.js';

export interface CatalogRouteDeps {
  vibeConfig: VibeDockConfig;
  catalogService: CatalogService;
  operationsService: OperationsService;
  authService: AuthService;
  aiConfigFile?: string;
}

export function createCatalogRoutes(deps: CatalogRouteDeps): Hono<AppEnv> {
  const { vibeConfig, catalogService, operationsService, authService, aiConfigFile } = deps;
  const router = new Hono<AppEnv>();

  router.get('/health', (c) => c.json({ status: 'ok' }));

  router.get('/dx/skill-package', (c) => {
    const user = c.get('user');
    const inviteCode = authService.getInviteCode();
    const queryCode = String(c.req.query('code') || '').trim();
    const codeValid = Boolean(inviteCode && queryCode && queryCode === inviteCode);
    if (!user && !codeValid) {
      return c.json({ error: '请先登录门户或附带有效的团队邀请码下载 Skill 包' }, 401);
    }
    const skillZipFile = vibeConfig.paths.skillZipFile;
    if (!fs.existsSync(skillZipFile)) {
      return c.json({ error: 'Skill 安装包暂不可用（请先执行 npx vibedock pack-skill 生成）' }, 404);
    }
    const zipBuffer = fs.readFileSync(skillZipFile);
    return new Response(zipBuffer, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${vibeConfig.skillName}.zip"`,
      },
    });
  });

  router.get('/catalog', requireAuth, async (c) => {
    const user = c.get('user')!;
    const unlocked = user.role === 'admin';
    const rawSnapshot = await catalogService.snapshot();
    const provisionedProjects = getDbStatus(vibeConfig).projects;
    const inviteCode = authService.getInviteCode();
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto') || url.protocol.replace(':', '') || 'http';
    const hostHeader = c.req.header('host') || `services.${rawSnapshot.environment?.domainSuffix || vibeConfig.primaryDomain}`;
    const skillPackageUrl = `${proto}://${hostHeader}/api/dx/skill-package${inviteCode ? `?code=${encodeURIComponent(inviteCode)}` : ''}`;

    const snapshotWithDx = {
      ...rawSnapshot,
      brandName: vibeConfig.brandName,
      portalTitle: vibeConfig.portalTitle,
      dx: {
        ...rawSnapshot.dx!,
        skillName: vibeConfig.skillName,
        deployUser: vibeConfig.deployUser,
        appPrefix: vibeConfig.appPrefix,
        provisionedProjects,
        skillPackageUrl,
      },
    };
    const snapshot = unlocked ? snapshotWithDx : redactSnapshotForPublic(snapshotWithDx);
    c.header('Cache-Control', 'no-store');
    return c.json({
      ...snapshot,
      actions: unlocked ? operationsService.list() : [],
      operations: { enabled: true, unlocked },
      user,
      assistant: assistantCapabilities(aiConfigFile),
    });
  });

  return router;
}
