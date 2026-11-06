import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { loadVibeDockConfig, PROJECT_ROOT } from './config.js';
import { createAssistantRoutes } from './http/assistant.js';
import { createAuthRoutes } from './http/auth.js';
import { createCatalogRoutes } from './http/catalog.js';
import { createAuthMiddleware, securityHeaders, type AppEnv } from './http/middleware.js';
import { createOperationsRoutes } from './http/operations.js';
import { createOperationsService } from './services/actions.js';
import { createAiConfigService } from './services/ai-config.js';
import { createAgentService } from './services/assistant/agent.js';
import { createWorkspaceTools } from './services/assistant/tools.js';
import { createAuthService } from './services/auth.js';
import { createCatalogService, loadAndValidateCatalog } from './services/catalog.js';
import { createHistoryService } from './services/history.js';
import type { VibeDockConfig } from './types.js';

export interface CreateAppOptions {
  vibeConfig?: VibeDockConfig;
  catalogFile?: string;
  authDbFile?: string;
  chatDbFile?: string;
  aiConfigFile?: string;
  aiKeyFile?: string;
  auditFile?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStaticFile(filePath: string): Response | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return null;
  }
}

export function createApp(options: CreateAppOptions = {}) {
  const vibeConfig = options.vibeConfig || loadVibeDockConfig();
  const catalogFile = options.catalogFile || path.join(vibeConfig.paths.dataDir, 'catalog.json');
  const catalog = loadAndValidateCatalog(catalogFile);
  const catalogService = createCatalogService(catalog, {
    dbHost: vibeConfig.serverHost,
    catalogFile,
  });

  const auditFile = options.auditFile || process.env.OPS_AUDIT_FILE;
  const aiConfigFile = options.aiConfigFile || process.env.AI_CONFIG_FILE;
  const aiKeyFile = options.aiKeyFile || process.env.AI_KEY_FILE;

  const operationsService = createOperationsService(catalog, catalogService, {
    auditFile,
    nodeBin: process.env.NODE_BIN,
    pm2Bin: process.env.PM2_BIN,
    caddyBin: vibeConfig.paths.caddyBin,
    caddyConfig: vibeConfig.paths.caddyConfig,
    deployUser: vibeConfig.deployUser,
    pm2Home: path.join(vibeConfig.paths.dataDir, 'deploy', '.pm2'),
  });

  const historyService = createHistoryService({
    databaseFile: options.chatDbFile || process.env.CHAT_DB_FILE || path.join(vibeConfig.paths.dataDir, 'vibedock-chat.sqlite3'),
  });

  const authService = createAuthService({
    databaseFile: options.authDbFile || process.env.AUTH_DB_FILE || path.join(vibeConfig.paths.dataDir, 'vibedock-auth.sqlite3'),
    defaultAdminUser: vibeConfig.auth.defaultAdminUser,
    defaultAdminDisplayName: vibeConfig.auth.defaultAdminDisplayName,
    defaultAdminPassword: vibeConfig.auth.defaultAdminPassword,
    defaultMemberPassword: vibeConfig.auth.defaultMemberPassword,
    defaultInviteCode: vibeConfig.auth.defaultInviteCode,
  });

  const workspaceTools = createWorkspaceTools({
    catalog,
    catalogService,
    operationsService,
  });

  const agentService = createAgentService({
    catalogService,
    catalog,
    operationsService,
    historyService,
    workspaceTools,
    configFile: aiConfigFile,
  });

  const aiConfigService = createAiConfigService({
    configFile: aiConfigFile,
    keyFile: aiKeyFile,
    auditFile,
  });

  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders);
  app.use('/api/*', createAuthMiddleware(authService));

  app.route('/api/auth', createAuthRoutes(authService));
  app.route(
    '/api',
    createCatalogRoutes({
      vibeConfig,
      catalogService,
      operationsService,
      authService,
      aiConfigFile,
    }),
  );
  app.route(
    '/api/assistant',
    createAssistantRoutes({
      agentService,
      historyService,
    }),
  );
  app.route(
    '/api',
    createOperationsRoutes({
      operationsService,
      aiConfigService,
    }),
  );

  const publicDir = path.join(PROJECT_ROOT, 'public');
  const skillZipResolved = path.resolve(vibeConfig.paths.skillZipFile);
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: '接口不存在' }, 404);
    }
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const resolved = path.resolve(publicDir, `.${reqPath}`);
    if (
      (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, 'index.html')) ||
      resolved === skillZipResolved ||
      path.extname(resolved).toLowerCase() === '.zip'
    ) {
      return c.notFound();
    }
    return serveStaticFile(resolved) || c.notFound();
  });

  app.onError((error: any, c) => {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) {
      console.error('Request failed', error);
    }
    const message = status < 500 || error?.expose ? error.message : '服务目录暂时不可用';
    return c.json({ error: message }, status as any);
  });

  function close(): void {
    agentService.shutdown();
    historyService.close();
    authService.close();
  }

  return {
    app,
    vibeConfig,
    catalogService,
    operationsService,
    historyService,
    authService,
    agentService,
    aiConfigService,
    close,
  };
}
