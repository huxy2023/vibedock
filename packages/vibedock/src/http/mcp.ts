import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import {
  bindProjectDbs,
  formatDbEnv,
  getDbStatus,
  getProjectDbRecord,
  provisionProjectDbs,
} from '../deploy/databases.js';
import { allocateAppSlot, publishApp, unpublishApp } from '../deploy/publish.js';
import {
  buildActivateRemoteCmd,
  buildLogsRemoteCmd,
  buildStartServiceRemoteCmd,
} from '../skill/client.js';
import type { DatabaseEngine, PublishManifest, VibeDockConfig } from '../types.js';
import type { AppEnv } from './middleware.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RELEASE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function normalizeProjectSlug(rawId: string, prefix: string): string {
  let val = String(rawId || '').trim().toLowerCase();
  if (prefix && val.startsWith(prefix)) val = val.slice(prefix.length);
  if (!SLUG_RE.test(val)) {
    throw new Error('Invalid project ID format');
  }
  return val;
}

function safeTokenCompare(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyDeployAccess(c: Context<AppEnv>, vibeConfig: VibeDockConfig): boolean {
  if (c.get('user')) return true;
  const expectedToken = String(vibeConfig.deployToken || process.env.VIBEDOCK_DEPLOY_TOKEN || '').trim();
  if (!expectedToken) return false;
  const authHeader = String(c.req.header('authorization') || '').trim();
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const headerToken = String(c.req.header('x-vibedock-token') || '').trim();
  const candidate = bearer || headerToken;
  return safeTokenCompare(expectedToken, candidate);
}

function writeProjectDbEnvFile(vibeConfig: VibeDockConfig, projectId: string, envContent: string): string {
  const slug = normalizeProjectSlug(projectId, vibeConfig.appPrefix);
  const secretsDir = path.join(vibeConfig.paths.appsDir, slug, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const envFile = path.join(secretsDir, 'db.env');
  fs.writeFileSync(envFile, envContent, { mode: 0o600 });
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    spawnSync('chown', ['-R', `${vibeConfig.deployUser}:${vibeConfig.deployUser}`, path.join(vibeConfig.paths.appsDir, slug)]);
  }
  return envFile;
}

function runDeployShellScript(vibeConfig: VibeDockConfig, cmd: string): any {
  const deployPm2Home = path.join(vibeConfig.paths.dataDir, 'deploy', '.pm2');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
    PM2_HOME: deployPm2Home,
  };
  let res;
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    res = spawnSync(
      'sudo',
      ['-n', '-u', vibeConfig.deployUser, '/usr/bin/env', `PATH=${env.PATH}`, `PM2_HOME=${deployPm2Home}`, 'bash', '-lc', cmd],
      { encoding: 'utf8', env },
    );
  } else {
    res = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8', env });
  }
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `Command exited with status ${res.status}`).trim());
  }
  const out = (res.stdout || '').trim();
  try {
    return JSON.parse(out);
  } catch {
    return { ok: true, output: out };
  }
}

export const MCP_TOOLS = [
  {
    name: 'vibedock_check',
    description: 'Check VibeDock server & portal status and available port range',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vibedock_alloc',
    description: 'Allocate or query recommended port and hostnames for a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID slug (e.g. my-app)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'vibedock_db_status',
    description: 'Inspect shared/external database status and provisioned projects',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vibedock_db_provision',
    description: 'Provision isolated databases for a project and write secrets/db.env',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID slug' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['postgresql', 'mysql', 'mongodb', 'redis'] },
          description: 'Database engines to provision',
        },
        writeEnvFile: { type: 'boolean', description: 'Automatically write secrets/db.env on server (default true)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'vibedock_db_bind',
    description: 'Bind existing external database connection URLs to a project and write secrets/db.env',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        postgresql: { type: 'string' },
        mysql: { type: 'string' },
        mongodb: { type: 'string' },
        redis: { type: 'string' },
        writeEnvFile: { type: 'boolean' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'vibedock_db_get',
    description: 'Get provisioned/bound database connection info or .env content for a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        format: { type: 'string', enum: ['json', 'env'] },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'vibedock_start_service',
    description: 'Controlled service startup: switch current symlink, load secrets/db.env, install deps, and start PM2 process',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        release: { type: 'string' },
        entry: { type: 'string' },
        port: { type: 'number' },
        component: { type: 'string' },
        runtime: { type: 'string', enum: ['node', 'python', 'go'] },
      },
      required: ['projectId', 'release', 'entry', 'port'],
    },
  },
  {
    name: 'vibedock_activate',
    description: 'Atomically switch the current symlink of a project to a specific release',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        release: { type: 'string' },
      },
      required: ['projectId', 'release'],
    },
  },
  {
    name: 'vibedock_publish',
    description: 'Validate contract, generate gateway route (Caddy/Nginx), and register project in portal catalog',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'object', description: 'publish.json manifest object' },
      },
      required: ['manifest'],
    },
  },
  {
    name: 'vibedock_adopt',
    description: 'Adopt an existing local/intranet/Docker port service and mount subdomain & portal card',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        upstream: { type: 'string', description: 'Upstream URL (e.g. http://127.0.0.1:8080)' },
        name: { type: 'string' },
        owner: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['id', 'upstream'],
    },
  },
  {
    name: 'vibedock_logs',
    description: 'Inspect PM2 process status and recent stdout/stderr logs for a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        lines: { type: 'number' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'vibedock_unpublish',
    description: 'Unpublish a project, remove gateway route, and stop PM2 processes',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
];

export interface McpRouteDeps {
  vibeConfig: VibeDockConfig;
  skipPortCheck?: boolean;
  skipCaddyReload?: boolean;
}

export function createMcpRoutes(deps: McpRouteDeps): Hono<AppEnv> {
  const { vibeConfig } = deps;
  const router = new Hono<AppEnv>();

  const skillAccessCfg = {
    serverHost: vibeConfig.serverHost,
    deployUser: vibeConfig.deployUser,
    appPrefix: vibeConfig.appPrefix,
    appsDir: vibeConfig.paths.appsDir,
    portalUrl: vibeConfig.portalUrl,
  };

  async function executeTool(name: string, args: Record<string, any> = {}): Promise<any> {
    switch (name) {
      case 'vibedock_check':
        return {
          ok: true,
          transport: 'http-mcp',
          serverHost: vibeConfig.serverHost,
          primaryDomain: vibeConfig.primaryDomain,
          portalUrl: vibeConfig.portalUrl,
          gateway: vibeConfig.gateway,
          gatewayStrategy: vibeConfig.gatewayStrategy || 'reuse',
          portRange: `${vibeConfig.portRange.start}-${vibeConfig.portRange.end}`,
        };

      case 'vibedock_alloc':
        return allocateAppSlot(vibeConfig, String(args.projectId || args.id || ''));

      case 'vibedock_db_status':
        return getDbStatus(vibeConfig);

      case 'vibedock_db_provision': {
        const projectId = String(args.projectId || args.id || '');
        const rawTypes = Array.isArray(args.types)
          ? args.types
          : typeof args.types === 'string'
            ? args.types.split(',').map((s: string) => s.trim()).filter(Boolean)
            : ['postgresql', 'mysql', 'mongodb', 'redis'];
        const record = await provisionProjectDbs(vibeConfig, projectId, rawTypes as DatabaseEngine[]);
        const envText = formatDbEnv(record);
        const envFile = args.writeEnvFile !== false ? writeProjectDbEnvFile(vibeConfig, projectId, envText) : undefined;
        return { ok: true, ...record, envFile, env: envText };
      }

      case 'vibedock_db_bind': {
        const projectId = String(args.projectId || args.id || '');
        const record = bindProjectDbs(vibeConfig, projectId, {
          postgresql: args.postgresql,
          mysql: args.mysql,
          mongodb: args.mongodb,
          redis: args.redis,
        });
        const envText = formatDbEnv(record);
        const envFile = args.writeEnvFile !== false ? writeProjectDbEnvFile(vibeConfig, projectId, envText) : undefined;
        return { ok: true, ...record, envFile, env: envText };
      }

      case 'vibedock_db_get': {
        const projectId = String(args.projectId || args.id || '');
        const record = getProjectDbRecord(vibeConfig, projectId);
        const envText = formatDbEnv(record);
        if (args.format === 'env') {
          return { ok: true, project: record.project, env: envText };
        }
        return { ok: true, ...record, env: envText };
      }

      case 'vibedock_start_service': {
        const cmd = buildStartServiceRemoteCmd(skillAccessCfg, {
          projectId: String(args.projectId || args.id || ''),
          release: String(args.release || ''),
          entry: String(args.entry || ''),
          port: Number(args.port),
          component: args.component ? String(args.component) : 'api',
          runtime: (args.runtime || 'node') as 'node' | 'python' | 'go',
        });
        return runDeployShellScript(vibeConfig, cmd);
      }

      case 'vibedock_activate': {
        const cmd = buildActivateRemoteCmd(
          skillAccessCfg,
          String(args.projectId || args.id || ''),
          String(args.release || ''),
        );
        return runDeployShellScript(vibeConfig, cmd);
      }

      case 'vibedock_publish': {
        const manifest = (args.manifest || args) as PublishManifest;
        return publishApp(vibeConfig, manifest, {
          skipPortCheck: deps.skipPortCheck,
          skipCaddyReload: deps.skipCaddyReload,
        });
      }

      case 'vibedock_adopt': {
        const id = String(args.id || args.projectId || '').trim();
        const upstream = String(args.upstream || '').trim();
        if (!id || !upstream) throw new Error('id and upstream are required');
        return publishApp(
          vibeConfig,
          {
            id,
            name: String(args.name || id),
            owner: String(args.owner || 'Team'),
            category: String(args.category || '内部系统'),
            description: String(args.description || `已纳管服务 (${upstream})`),
            tags: ['Adopted', 'External'],
            components: [{ id: 'upstream', name: 'Upstream Service', kind: 'external', upstream }],
          },
          {
            skipPortCheck: deps.skipPortCheck,
            skipCaddyReload: deps.skipCaddyReload,
          },
        );
      }

      case 'vibedock_logs': {
        const cmd = buildLogsRemoteCmd(
          skillAccessCfg,
          String(args.projectId || args.id || ''),
          Number(args.lines || 80),
        );
        return runDeployShellScript(vibeConfig, cmd);
      }

      case 'vibedock_unpublish':
        return unpublishApp(vibeConfig, String(args.projectId || args.id || ''));

      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  router.post('/mcp', async (c) => {
    if (!verifyDeployAccess(c, vibeConfig)) {
      return c.json({ error: '未授权：请提供有效的 Bearer deployToken 或门户登录凭证' }, 401);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const { id = null, method, params = {} } = body as Record<string, any>;

    try {
      if (method === 'initialize') {
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'vibedock-mcp', version: '0.0.5' },
          },
        });
      }
      if (method === 'notifications/initialized') {
        return c.json({ jsonrpc: '2.0', id, result: {} });
      }
      if (method === 'ping') {
        return c.json({ jsonrpc: '2.0', id, result: {} });
      }
      if (method === 'tools/list') {
        return c.json({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      }
      if (method === 'tools/call') {
        const toolName = String(params?.name || '');
        const toolArgs = (params?.arguments || {}) as Record<string, any>;
        try {
          const data = await executeTool(toolName, toolArgs);
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
              structuredContent: data,
            },
          });
        } catch (err: any) {
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: err?.message || String(err) }],
            },
          });
        }
      }
      return c.json(
        { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } },
        404,
      );
    } catch (err: any) {
      return c.json(
        { jsonrpc: '2.0', id, error: { code: -32603, message: err?.message || 'Internal error' } },
        500,
      );
    }
  });

  router.post('/dx/upload', async (c) => {
    if (!verifyDeployAccess(c, vibeConfig)) {
      return c.json({ error: '未授权：请提供有效的 Bearer deployToken 或门户登录凭证' }, 401);
    }
    try {
      const rawProject = String(c.req.query('project') || '').trim();
      const release = String(c.req.query('release') || '').trim();
      const rawSubpath = String(c.req.query('subpath') || '').trim();
      const slug = normalizeProjectSlug(rawProject, vibeConfig.appPrefix);
      if (!RELEASE_RE.test(release)) {
        return c.json({ error: 'Invalid release identifier' }, 400);
      }
      const appsRoot = path.resolve(vibeConfig.paths.appsDir);
      const baseReleaseDir = path.resolve(appsRoot, slug, 'releases', release);
      const targetDir = rawSubpath ? path.resolve(baseReleaseDir, rawSubpath) : baseReleaseDir;
      if (targetDir !== baseReleaseDir && !targetDir.startsWith(`${baseReleaseDir}${path.sep}`)) {
        return c.json({ error: 'Invalid subpath (path traversal rejected)' }, 400);
      }

      const buf = Buffer.from(await c.req.arrayBuffer());
      if (buf.length === 0) {
        return c.json({ error: 'Empty upload payload' }, 400);
      }

      fs.mkdirSync(appsRoot, { recursive: true, mode: 0o755 });
      const realAppsRoot = fs.realpathSync(appsRoot);
      const allRelSegments = path.relative(appsRoot, targetDir).split(path.sep).filter(Boolean);
      let cur = appsRoot;
      for (const seg of allRelSegments) {
        cur = path.join(cur, seg);
        const st = fs.lstatSync(cur, { throwIfNoEntry: false });
        if (st?.isSymbolicLink()) {
          return c.json({ error: 'Invalid target path (symlink segment rejected)' }, 400);
        }
      }

      fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
      const realBase = fs.realpathSync(baseReleaseDir);
      const realTarget = fs.realpathSync(targetDir);
      if (
        !realBase.startsWith(`${realAppsRoot}${path.sep}`) ||
        (realTarget !== realBase && !realTarget.startsWith(`${realBase}${path.sep}`))
      ) {
        return c.json({ error: 'Invalid subpath (symlink escape rejected)' }, 400);
      }

      const tmpTar = path.join(os.tmpdir(), `vibedock-upload-${process.pid}-${Date.now()}.tar.gz`);
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-stage-'));
      try {
        fs.writeFileSync(tmpTar, buf, { mode: 0o600 });
        const listRes = spawnSync('tar', ['-tvzf', tmpTar], { encoding: 'utf8' });
        if (listRes.status !== 0) {
          return c.json({ error: `Invalid archive: ${(listRes.stderr || listRes.stdout || '').trim()}` }, 400);
        }
        for (const line of (listRes.stdout || '').split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (/^[lhbcp]/.test(trimmed)) {
            return c.json({ error: 'Archive contains disallowed symbolic/hard links or special files' }, 400);
          }
        }
        const namesRes = spawnSync('tar', ['-tzf', tmpTar], { encoding: 'utf8' });
        for (const entryName of (namesRes.stdout || '').split(/\r?\n/)) {
          const clean = entryName.trim();
          if (!clean) continue;
          if (clean.startsWith('/') || clean.split('/').includes('..')) {
            return c.json({ error: 'Archive contains disallowed path traversal entry' }, 400);
          }
        }

        const untar = spawnSync('tar', ['-xzf', tmpTar, '-C', stageDir], { encoding: 'utf8' });
        if (untar.status !== 0) {
          return c.json({ error: `Failed to extract archive: ${(untar.stderr || untar.stdout || '').trim()}` }, 400);
        }

        const copySafeNoSymlinks = (srcDir: string, dstDir: string): void => {
          for (const item of fs.readdirSync(srcDir)) {
            const srcFull = path.join(srcDir, item);
            const dstFull = path.join(dstDir, item);
            const srcSt = fs.lstatSync(srcFull);
            if (srcSt.isSymbolicLink() || (!srcSt.isFile() && !srcSt.isDirectory())) {
              throw new Error('Archive contains disallowed symbolic link or special file');
            }
            const dstSt = fs.lstatSync(dstFull, { throwIfNoEntry: false });
            if (dstSt?.isSymbolicLink()) {
              throw new Error('Destination path contains disallowed symbolic link');
            }
            if (srcSt.isDirectory()) {
              if (dstSt && !dstSt.isDirectory()) {
                fs.rmSync(dstFull, { force: true });
              }
              fs.mkdirSync(dstFull, { recursive: true, mode: 0o755 });
              copySafeNoSymlinks(srcFull, dstFull);
            } else {
              if (dstSt?.isDirectory()) {
                fs.rmSync(dstFull, { recursive: true, force: true });
              }
              fs.copyFileSync(srcFull, dstFull);
              fs.chmodSync(dstFull, srcSt.mode & 0o777);
            }
          }
        };
        copySafeNoSymlinks(stageDir, realTarget);
      } finally {
        fs.rmSync(tmpTar, { force: true });
        fs.rmSync(stageDir, { recursive: true, force: true });
      }

      if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
        spawnSync('chown', ['-R', `${vibeConfig.deployUser}:${vibeConfig.deployUser}`, path.join(vibeConfig.paths.appsDir, slug)]);
      }

      return c.json({
        ok: true,
        project: slug,
        release,
        targetDir,
        bytes: buf.length,
      });
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
  });

  return router;
}
