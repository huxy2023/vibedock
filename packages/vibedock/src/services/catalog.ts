import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { buildCaddyConfig, ingressScheme, listenerScope } from '../deploy/caddy.js';
import type { CatalogData, CatalogListener } from '../types.js';

export const SHARED_DATABASES = [
  { id: 'mysql', name: 'MySQL 8.0', port: 3306, host: '127.0.0.1', envKey: 'MYSQL_URL', isolation: '独立库 + 专属账号 proj_<id>', exampleUrl: 'mysql://proj_<id>:<pwd>@<host>:3306/proj_<id>' },
  { id: 'postgresql', name: 'PostgreSQL 16', port: 5432, host: '127.0.0.1', envKey: 'POSTGRES_URL', isolation: '独立库 + 专属账号 proj_<id>', exampleUrl: 'postgresql://proj_<id>:<pwd>@<host>:5432/proj_<id>' },
  { id: 'mongodb', name: 'MongoDB 8.0', port: 27017, host: '127.0.0.1', envKey: 'MONGODB_URI', isolation: '独立库 + 专属账号 proj_<id>', exampleUrl: 'mongodb://proj_<id>:<pwd>@<host>:27017/proj_<id>?authSource=proj_<id>' },
  { id: 'redis', name: 'Redis 7.0', port: 6379, host: '127.0.0.1', envKey: 'REDIS_URL', isolation: 'ACL 账号 + <id>:* 键前缀隔离', exampleUrl: 'redis://proj_<id>:<pwd>@<host>:6379/0' },
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid catalog: ${message}`);
}

function listenerKey(listener: CatalogListener): string {
  return `${listener.host}:${listener.port}`;
}

function isValidHostname(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 253) return false;
  return value.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

function targetKey(projectId: string, target: { component: string; listener?: string }): string {
  return `${projectId}/${target.component}/${target.listener || 'static'}`;
}

export function validateCatalog(catalog: CatalogData): CatalogData {
  assert(catalog && typeof catalog === 'object', 'root must be an object');
  assert(Array.isArray(catalog.projects), 'projects must be an array');

  const projectIds = new Set<string>();
  const occupiedListeners = new Map<string, string>();
  const ingressMatches = new Map<string, string>();
  const ingressSites = new Map<string, string>();

  for (const project of catalog.projects) {
    assert(project.id && !projectIds.has(project.id), `duplicate project id ${project.id}`);
    projectIds.add(project.id);
    assert(project.name, `project ${project.id} must have a name`);
    assert(
      project.aliases === undefined ||
        (Array.isArray(project.aliases) && project.aliases.every((alias) => typeof alias === 'string' && alias.trim())),
      `project ${project.id} aliases must be non-empty strings`,
    );
    assert(Array.isArray(project.components), `project ${project.id} components must be an array`);
    assert(Array.isArray(project.ingressRules), `project ${project.id} ingressRules must be an array`);

    const components = new Map<string, { component: (typeof project.components)[0]; listeners: Map<string, CatalogListener> }>();
    for (const component of project.components) {
      assert(component.id && !components.has(component.id), `duplicate component ${project.id}/${component.id}`);
      assert(component.name, `component ${project.id}/${component.id} must have a name`);
      assert(Array.isArray(component.listeners), `component ${project.id}/${component.id} listeners must be an array`);
      if (component.processName) {
        assert(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(component.processName), `invalid process name for ${project.id}/${component.id}`);
      }

      if (component.type === 'static') {
        assert(component.listeners.length === 0, `static component ${project.id}/${component.id} cannot own listeners`);
        assert(path.isAbsolute(component.staticRoot || ''), `static component ${project.id}/${component.id} requires an absolute staticRoot`);
      } else {
        assert(component.listeners.length > 0, `proxy component ${project.id}/${component.id} requires at least one listener`);
      }

      const listeners = new Map<string, CatalogListener>();
      for (const listener of component.listeners) {
        assert(listener.id && !listeners.has(listener.id), `duplicate listener ${project.id}/${component.id}/${listener.id}`);
        const scope = listenerScope(listener);
        assert(['local', 'remote'].includes(scope), `invalid listener scope for ${project.id}/${component.id}/${listener.id}`);
        if (scope === 'local') {
          assert(listener.host === '127.0.0.1' || listener.host === '::1', `local listener ${project.id}/${component.id}/${listener.id} must be loopback-only`);
        } else {
          assert(listener.host !== '127.0.0.1' && listener.host !== '::1', `remote listener ${project.id}/${component.id}/${listener.id} cannot use a loopback host`);
          assert(net.isIP(listener.host) !== 0 || isValidHostname(listener.host), `invalid remote host for ${project.id}/${component.id}/${listener.id}`);
        }
        assert(Number.isInteger(listener.port) && listener.port > 0 && listener.port < 65536, `invalid port for ${project.id}/${component.id}/${listener.id}`);
        assert(['http', 'https', 'websocket', 'tcp'].includes(listener.protocol), `invalid listener protocol for ${project.id}/${component.id}/${listener.id}`);

        const occupiedKey = listenerKey(listener);
        const owner = `${project.id}/${component.id}/${listener.id}`;
        assert(!occupiedListeners.has(occupiedKey), `listener ${occupiedKey} is shared by ${occupiedListeners.get(occupiedKey)} and ${owner}`);
        occupiedListeners.set(occupiedKey, owner);
        listeners.set(listener.id, listener);
      }

      components.set(component.id, { component, listeners });
    }

    for (const rule of project.ingressRules) {
      assert(rule.id, `project ${project.id} has an ingress rule without id`);
      assert(rule.match && Array.isArray(rule.match.hosts) && rule.match.hosts.length, `ingress ${project.id}/${rule.id} requires hosts`);
      assert(Array.isArray(rule.match.paths) && rule.match.paths.length, `ingress ${project.id}/${rule.id} requires paths`);
      assert(['http', 'websocket'].includes(rule.match.protocol), `invalid ingress protocol for ${project.id}/${rule.id}`);
      const scheme = ingressScheme(rule);
      assert(['http', 'https'].includes(scheme), `invalid ingress scheme for ${project.id}/${rule.id}`);
      if (rule.tls && (rule.tls.certificateFile || rule.tls.keyFile)) {
        assert(scheme === 'https', `TLS files require an HTTPS ingress for ${project.id}/${rule.id}`);
        assert(path.isAbsolute(rule.tls.certificateFile || ''), `TLS certificate file must be absolute for ${project.id}/${rule.id}`);
        assert(path.isAbsolute(rule.tls.keyFile || ''), `TLS key file must be absolute for ${project.id}/${rule.id}`);
      } else {
        delete rule.tls;
      }

      const componentRecord = components.get(rule.target?.component);
      assert(componentRecord, `ingress ${project.id}/${rule.id} references missing component ${rule.target?.component}`);
      if (componentRecord.component.type === 'static') {
        assert(!rule.target.listener, `static ingress ${project.id}/${rule.id} must not reference a listener`);
      } else {
        assert(componentRecord.listeners.has(rule.target.listener || ''), `ingress ${project.id}/${rule.id} references missing listener ${rule.target.listener}`);
      }

      for (const host of rule.match.hosts) {
        assert(/^[a-z0-9.-]+$/i.test(host), `invalid host ${host}`);
        const siteKey = `${scheme}://${host.toLowerCase()}`;
        const tlsKey = rule.tls ? `${rule.tls.certificateFile}|${rule.tls.keyFile}` : '';
        const existingTlsKey = ingressSites.get(siteKey);
        assert(existingTlsKey === undefined || existingTlsKey === tlsKey, `inconsistent TLS configuration at ${siteKey}`);
        ingressSites.set(siteKey, tlsKey);
        for (const routePath of rule.match.paths) {
          assert(routePath.startsWith('/'), `path ${routePath} must start with /`);
          const matchKey = `${siteKey}|${routePath}|${rule.match.protocol}`;
          const destination = targetKey(project.id, rule.target);
          const existing = ingressMatches.get(matchKey);
          assert(!existing || existing === destination, `ingress conflict at ${matchKey}: ${existing} and ${destination}`);
          ingressMatches.set(matchKey, destination);
        }
      }
    }
  }

  return catalog;
}

export function loadAndValidateCatalog(filePath: string): CatalogData {
  return validateCatalog(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function checkTcpListener(
  listener: { host: string; port: number },
  timeoutMs = 600,
): Promise<{ online: boolean; checkedAt: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: listener.host, port: listener.port });
    let settled = false;

    function finish(online: boolean) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ online, checkedAt: new Date().toISOString() });
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export interface CatalogServiceOptions {
  catalogFile?: string;
  cacheMs?: number;
  dbHost?: string;
  checker?: (listener: { host: string; port: number }) => Promise<{ online: boolean; checkedAt?: string }>;
}

export function createCatalogService(initialCatalog: CatalogData, options: CatalogServiceOptions = {}) {
  const cacheMs = options.cacheMs ?? 5_000;
  const checker = options.checker ?? checkTcpListener;
  const catalogFile = options.catalogFile;

  let currentCatalog = initialCatalog;
  let lastMtimeMs = catalogFile && fs.existsSync(catalogFile) ? fs.statSync(catalogFile).mtimeMs : 0;
  let cachedSnapshot: CatalogData | undefined;
  let cachedAt = 0;
  let inFlight: Promise<CatalogData> | undefined;

  function getLatestCatalog(): CatalogData {
    if (catalogFile && fs.existsSync(catalogFile)) {
      try {
        const stat = fs.statSync(catalogFile);
        if (stat.mtimeMs !== lastMtimeMs) {
          currentCatalog = loadAndValidateCatalog(catalogFile);
          lastMtimeMs = stat.mtimeMs;
          cachedSnapshot = undefined;
        }
      } catch (err: any) {
        console.warn(`[catalog] Failed to hot-reload ${catalogFile}: ${err.message}`);
      }
    }
    return currentCatalog;
  }

  async function buildSnapshot(): Promise<CatalogData> {
    const source = getLatestCatalog();
    const cloned = structuredClone(source);
    const listenerChecks: Array<Promise<unknown>> = [];

    for (const project of cloned.projects) {
      for (const component of project.components) {
        for (const listener of component.listeners) {
          listenerChecks.push(checker(listener).then((status) => Object.assign(listener, status)));
        }
      }
    }

    await Promise.all(listenerChecks);

    for (const project of cloned.projects) {
      for (const component of project.components) {
        component.online =
          component.type === 'static'
            ? fs.existsSync(path.join(component.staticRoot || '', 'index.html'))
            : component.listeners.every((listener) => listener.online);
      }
      project.status = project.components.every((component) => component.online) ? 'online' : 'degraded';
      project.caddyConfig = buildCaddyConfig(project);
    }

    const dbHost = cloned.environment?.address || options.dbHost || '127.0.0.1';
    const databases = await Promise.all(
      SHARED_DATABASES.map(async (db) => {
        const status = await checker({ host: '127.0.0.1', port: db.port });
        return {
          ...db,
          host: dbHost,
          exampleUrl: db.exampleUrl.replace('<host>', dbHost),
          online: Boolean(status?.online),
          checkedAt: status?.checkedAt,
        };
      }),
    );

    const listeners = cloned.projects.flatMap((project) =>
      project.components.flatMap((component) => component.listeners),
    );
    const usedTeamPorts: NonNullable<CatalogData['dx']>['portPool']['usedPorts'] = [];
    const usedPortSet = new Set<number>();

    for (const project of cloned.projects) {
      for (const component of project.components) {
        for (const listener of component.listeners) {
          if (listener.port >= 40000 && listener.port <= 40999) {
            usedPortSet.add(listener.port);
            usedTeamPorts.push({
              port: listener.port,
              projectId: project.id,
              projectName: project.name,
              componentId: component.id,
              componentName: component.name,
              online: Boolean(listener.online),
            });
          }
        }
      }
    }
    usedTeamPorts.sort((a, b) => a.port - b.port);
    let nextAvailablePort = 40000;
    while (usedPortSet.has(nextAvailablePort) && nextAvailablePort <= 40999) {
      nextAvailablePort += 1;
    }

    cloned.generatedAt = new Date().toISOString();
    cloned.summary = {
      projects: cloned.projects.length,
      components: cloned.projects.reduce((sum, project) => sum + project.components.length, 0),
      listeners: listeners.length,
      onlineListeners: listeners.filter((listener) => listener.online).length,
      staticComponents: cloned.projects.flatMap((project) => project.components).filter((component) => component.type === 'static').length,
      ingressRules: cloned.projects.reduce((sum, project) => sum + project.ingressRules.length, 0),
      portConflicts: 0,
      onlineDatabases: databases.filter((db) => db.online).length,
      totalDatabases: databases.length,
    };
    cloned.dx = {
      portPool: {
        range: '40000–40999',
        minPort: 40000,
        maxPort: 40999,
        nextAvailablePort,
        usedPorts: usedTeamPorts,
      },
      databases,
      provisionedProjects: [],
    };
    return cloned;
  }

  return {
    current(): CatalogData {
      return getLatestCatalog();
    },
    async snapshot(): Promise<CatalogData> {
      getLatestCatalog();
      const now = Date.now();
      if (cachedSnapshot && now - cachedAt < cacheMs) return cachedSnapshot;
      if (!inFlight) {
        inFlight = buildSnapshot().then(
          (snapshot) => {
            cachedSnapshot = snapshot;
            cachedAt = Date.now();
            inFlight = undefined;
            return snapshot;
          },
          (error) => {
            inFlight = undefined;
            throw error;
          },
        );
      }
      return inFlight;
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;

export function redactSnapshotForPublic(snapshot: CatalogData): CatalogData {
  const cloned = structuredClone(snapshot);
  for (const project of cloned.projects || []) {
    delete project.projectPath;
    delete project.configPath;
    project.caddyConfig = '# 管理员角色可查看完整 Caddy 配置与服务器目录路径';
    project.commands = (project.commands || []).filter(
      (item) => !/(-u\s+\S+|\/home\/ubuntu|\/var\/lib|password|token|secret)/i.test(item.command || ''),
    );
    for (const component of project.components || []) {
      if (component.staticRoot) {
        component.staticRoot = '[受保护静态站点目录]';
      }
    }
    for (const rule of project.ingressRules || []) {
      if (rule.tls) {
        rule.tls = { managed: true };
      }
    }
  }
  return cloned;
}

export { buildCaddyConfig, ingressScheme };
