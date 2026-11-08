import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCaddyConfig, buildNginxConfig } from './caddy.js';
import { isPortListeningByDeployUser, withFileLock, writeFileAtomic } from './utils.js';
import type {
  CatalogComponent,
  CatalogData,
  CatalogProject,
  IngressRule,
  PublishManifest,
  VibeDockConfig,
} from '../types.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const COMP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const RUNTIME_LABELS: Record<string, string> = {
  node: 'Node.js Service',
  python: 'Python (uv) Service',
  go: 'Go Binary Service',
  service: 'Local Port Service',
};

function normalizeSlug(raw: string, prefix: string): string {
  let val = String(raw || '').trim().toLowerCase();
  if (val.startsWith(prefix)) val = val.slice(prefix.length);
  if (!SLUG_RE.test(val)) {
    throw new Error('id must be 1-32 lowercase letters, digits, or hyphens');
  }
  return val;
}

function loadCatalog(cfg: VibeDockConfig): { catalogPath: string; catalog: CatalogData } {
  const catalogPath = path.join(cfg.paths.dataDir, 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    return {
      catalogPath,
      catalog: {
        environment: {
          name: `${cfg.brandName} Server`,
          gatewayPort: cfg.gatewayStrategy === 'dedicated-port' ? cfg.gatewayHttpPort || 8080 : 80,
          gatewayTlsPort: cfg.gatewayStrategy === 'dedicated-port' ? cfg.gatewayHttpsPort || 8443 : 443,
        } as any,
        projects: [],
      },
    };
  }
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as CatalogData;
  return { catalogPath, catalog };
}

function collectUsedPorts(catalog: CatalogData, excludeProjectId?: string): Set<number> {
  const used = new Set<number>();
  for (const project of catalog.projects || []) {
    if (excludeProjectId && project.id === excludeProjectId) continue;
    for (const comp of project.components || []) {
      for (const listener of comp.listeners || []) {
        if (Number.isInteger(listener.port)) used.add(listener.port);
      }
    }
  }
  return used;
}

export function allocateAppSlot(cfg: VibeDockConfig, rawId: string) {
  const slug = normalizeSlug(rawId, cfg.appPrefix);
  const projectId = `${cfg.appPrefix}${slug}`;
  const { catalog } = loadCatalog(cfg);
  const existing = catalog.projects.find((p) => p.id === projectId);
  const existingPorts: Record<string, number> = {};

  if (existing) {
    const ownedByDeploy = existing.components.some((c) =>
      String(c.processManager || '').includes(cfg.deployUser),
    );
    if (!ownedByDeploy) {
      throw new Error(`Project id ${projectId} is reserved by a system service`);
    }
    for (const comp of existing.components) {
      for (const listener of comp.listeners) {
        if (Number.isInteger(listener.port)) existingPorts[comp.id] = listener.port;
      }
    }
  }

  const used = collectUsedPorts(catalog, projectId);
  const recommendedPorts: number[] = [];
  for (let p = cfg.portRange.start; p <= cfg.portRange.end; p += 1) {
    if (!used.has(p)) {
      recommendedPorts.push(p);
      if (recommendedPorts.length >= 3) break;
    }
  }

  const hosts = [`${projectId}.${cfg.primaryDomain}`];
  if (cfg.backupDomain) hosts.push(`${projectId}.${cfg.backupDomain}`);

  return {
    slug,
    projectId,
    exists: Boolean(existing),
    existingPorts,
    recommendedPort: Object.values(existingPorts)[0] ?? recommendedPorts[0] ?? cfg.portRange.start,
    recommendedPorts,
    portRange: `${cfg.portRange.start}-${cfg.portRange.end}`,
    hosts,
    appDir: path.join(cfg.paths.appsDir, slug, 'current'),
  };
}

export function publishApp(
  cfg: VibeDockConfig,
  manifest: PublishManifest,
  options: { skipPortCheck?: boolean; skipCaddyReload?: boolean } = {},
) {
  const lockFile = path.join(cfg.paths.dataDir, 'publish.lock');
  return withFileLock(lockFile, () => {
    const slug = normalizeSlug(manifest.id, cfg.appPrefix);
    const projectId = `${cfg.appPrefix}${slug}`;
    const name = String(manifest.name || manifest.title || '').trim();
    const owner = String(manifest.owner || '').trim();
    const description = String(manifest.description || (manifest as any).summary || '').trim();
    if (!name || name.length > 80) throw new Error('name is required (<= 80 chars)');
    if (!owner || owner.length > 40) throw new Error('owner is required (<= 40 chars)');
    if (!description || description.length > 240) throw new Error('description is required (<= 240 chars)');

    const appDir = path.resolve(cfg.paths.appsDir, slug, 'current');
    const needsLocalAppDir = (manifest.components || []).some(
      (comp) => comp.kind === 'static' || (comp.kind === 'service' && !comp.upstream),
    );
    if (needsLocalAppDir && !fs.existsSync(appDir)) {
      throw new Error(`App directory does not exist: ${appDir}`);
    }

    const { catalogPath, catalog } = loadCatalog(cfg);
    const usedPorts = collectUsedPorts(catalog, projectId);
    const catalogComponents: CatalogComponent[] = [];
    const seenCompIds = new Set<string>();
    const seenPorts = new Set<number>();

    for (const comp of manifest.components || []) {
      const cid = String(comp.id || comp.name || 'upstream').trim().toLowerCase();
      if (!COMP_ID_RE.test(cid) || seenCompIds.has(cid)) {
        throw new Error(`Invalid or duplicate component id: ${cid}`);
      }
      seenCompIds.add(cid);

      if (comp.kind === 'static') {
        const relRoot = String(comp.root || '.').trim().replace(/^\/+/, '');
        if (relRoot !== '.' && !/^[A-Za-z0-9._/-]+$/.test(relRoot)) {
          throw new Error(`Invalid static root path: ${comp.root}`);
        }
        const staticRoot = path.resolve(appDir, relRoot);
        if (staticRoot !== appDir && !staticRoot.startsWith(`${appDir}${path.sep}`)) {
          throw new Error(`Static root escapes app directory: ${relRoot}`);
        }
        if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
          throw new Error(`Static component "${cid}" is missing index.html in ${staticRoot}`);
        }
        const routing = comp.routing || 'spa';
        catalogComponents.push({
          id: cid,
          name: cid,
          role: '静态站点',
          type: 'static',
          runtime: routing === 'spa' ? 'Caddy Static (SPA)' : 'Caddy Static',
          staticRoot,
          listeners: [],
        });
      } else if (comp.kind === 'external' || (comp.kind === 'service' && comp.upstream)) {
        const rawUpstream = String(comp.upstream || '').trim();
        if (!rawUpstream) {
          throw new Error(`External component "${cid}" requires an upstream address (e.g. "http://127.0.0.1:8080")`);
        }
        const parsed = new URL(rawUpstream.includes('://') ? rawUpstream : `http://${rawUpstream}`);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`Unsupported upstream protocol in "${rawUpstream}" (use http:// or https://)`);
        }
        const isHttpsUpstream = parsed.protocol === 'https:';
        const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
        const port = Number(parsed.port || (isHttpsUpstream ? 443 : 80));
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid upstream port in "${rawUpstream}"`);
        }
        const isLocal = host === '127.0.0.1' || host === '::1';
        catalogComponents.push({
          id: cid,
          name: cid,
          role: '已纳管存量服务',
          type: 'service',
          runtime: 'External / Adopted Service',
          processManager: `Adopted (${cfg.deployUser})`,
          listeners: [
            {
              id: 'http',
              name: isHttpsUpstream ? 'HTTPS' : 'HTTP',
              protocol: isHttpsUpstream ? 'https' : 'http',
              scope: isLocal ? 'local' : 'remote',
              host,
              port,
            },
          ],
        });
      } else if (comp.kind === 'service') {
        const port = Number(comp.port);
        if (!Number.isInteger(port) || port < cfg.portRange.start || port > cfg.portRange.end) {
          throw new Error(`Port ${port} must be in ${cfg.portRange.start}..${cfg.portRange.end}`);
        }
        if (seenPorts.has(port) || usedPorts.has(port)) {
          throw new Error(`Port ${port} is already allocated to another component or project`);
        }
        if (!options.skipPortCheck) {
          const check = isPortListeningByDeployUser(port, cfg.deployUser);
          if (!check.ok) throw new Error(check.error);
        }
        seenPorts.add(port);
        const runtimeKey = String(comp.runtime || 'service').toLowerCase();
        const pm2Name = `${projectId}-${cid}`;
        catalogComponents.push({
          id: cid,
          name: cid,
          role: '后端服务',
          type: 'service',
          runtime: RUNTIME_LABELS[runtimeKey] || RUNTIME_LABELS.service,
          processManager: `PM2 (${cfg.deployUser})`,
          deploymentProcess: pm2Name,
          listeners: [
            {
              id: 'http',
              name: 'HTTP',
              protocol: 'http',
              host: '127.0.0.1',
              port,
            },
          ],
        });
      } else {
        throw new Error(`Unsupported component kind: ${(comp as any).kind} (use "static", "service", or "external")`);
      }
    }

    if (!catalogComponents.length) {
      throw new Error('components must contain at least 1 component');
    }

    const gateway = cfg.gateway || 'caddy';
    const isNginx = gateway === 'nginx';
    const isDedicatedChain = cfg.gatewayStrategy === 'dedicated-chain';
    const customTls =
      !isDedicatedChain &&
      cfg.domainMode === 'custom' &&
      cfg.tls?.certFile &&
      cfg.tls?.keyFile &&
      /^\/[A-Za-z0-9._/-]+$/.test(cfg.tls.certFile) &&
      /^\/[A-Za-z0-9._/-]+$/.test(cfg.tls.keyFile)
        ? { certificateFile: cfg.tls.certFile, keyFile: cfg.tls.keyFile }
        : undefined;
    const scheme = cfg.domainMode === 'nip' || isDedicatedChain || (isNginx && !customTls) ? 'http' : 'https';
    const rawRoutes =
      Array.isArray(manifest.routes) && manifest.routes.length > 0
        ? manifest.routes
        : [{ component: catalogComponents[0].id, path: '/*' }];
    const ingressRules: IngressRule[] = rawRoutes.map((route, idx) => {
      const targetComp = catalogComponents.find((c) => c.id === route.component);
      if (!targetComp) throw new Error(`Route references unknown component: ${route.component}`);
      const sub = route.subdomain ? String(route.subdomain).trim().toLowerCase() : '';
      if (sub && !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sub)) {
        throw new Error(`Invalid route subdomain: ${route.subdomain}`);
      }
      const hostPrefix = route.host === 'sub' && sub ? `${projectId}-${sub}` : projectId;
      const hosts = [`${hostPrefix}.${cfg.primaryDomain}`];
      if (cfg.backupDomain) hosts.push(`${hostPrefix}.${cfg.backupDomain}`);
      const rawPath = String(route.path || '*').trim();
      const routePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
      if (!/^\/[A-Za-z0-9._~/*-]*$/.test(routePath)) {
        throw new Error(`Invalid route path: ${routePath}`);
      }
      return {
        id: `route-${idx + 1}`,
        name: `${route.component} (${routePath})`,
        match: {
          scheme,
          protocol: route.websocket ? 'websocket' : 'http',
          hosts,
          paths: [routePath],
        },
        ...(customTls ? { tls: customTls } : {}),
        target:
          targetComp.type === 'static'
            ? { component: targetComp.id }
            : { component: targetComp.id, listener: 'http' },
      };
    });

    if (!ingressRules.length) {
      throw new Error('routes must contain at least 1 route');
    }

    const sitesDir = isNginx
      ? cfg.paths.nginxSitesDir || path.join(cfg.paths.dataDir, 'nginx/sites')
      : cfg.paths.caddySitesDir;
    fs.mkdirSync(sitesDir, { recursive: true, mode: 0o755 });
    const siteFile = path.join(sitesDir, `${projectId}.${isNginx ? 'conf' : 'caddy'}`);
    const projectEntry: CatalogProject = {
      id: projectId,
      name,
      shortName: slug,
      owner,
      color: 'teal',
      description,
      aliases: [slug, name],
      tags: Array.from(new Set(['团队作品', ...(manifest.tags || [])])),
      projectPath: appDir,
      configPath: siteFile,
      components: catalogComponents,
      ingressRules,
      commands: [],
    };

    const hadPreviousSite = fs.existsSync(siteFile);
    const previousSiteContent = hadPreviousSite ? fs.readFileSync(siteFile, 'utf8') : null;
    const restorePreviousSite = () => {
      if (hadPreviousSite && previousSiteContent !== null) {
        writeFileAtomic(siteFile, previousSiteContent, 0o644);
      } else {
        fs.rmSync(siteFile, { force: true });
      }
    };

    const siteText = `# Managed by VibeDock (${projectId})\n${isNginx ? buildNginxConfig(projectEntry) : buildCaddyConfig(projectEntry)}\n`;
    writeFileAtomic(siteFile, siteText, 0o644);

    if (!options.skipCaddyReload && gateway === 'caddy' && fs.existsSync(cfg.paths.caddyConfig)) {
      const val = spawnSync(cfg.paths.caddyBin, ['validate', '--config', cfg.paths.caddyConfig, '--adapter', 'caddyfile'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (val.status !== 0) {
        restorePreviousSite();
        throw new Error(`Caddy validate failed: ${(val.stderr || val.stdout).trim()}`);
      }
      const rel = spawnSync(cfg.paths.caddyBin, ['reload', '--config', cfg.paths.caddyConfig, '--adapter', 'caddyfile'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (rel.status !== 0) {
        restorePreviousSite();
        throw new Error(`Caddy reload failed: ${(rel.stderr || rel.stdout).trim()}`);
      }
    } else if (!options.skipCaddyReload && gateway === 'nginx' && fs.existsSync(cfg.paths.nginxConfig || '/etc/nginx/nginx.conf')) {
      const nginxBin = cfg.paths.nginxBin || 'nginx';
      const val = spawnSync(nginxBin, ['-t'], { encoding: 'utf8', timeout: 10000 });
      if (val.status !== 0) {
        restorePreviousSite();
        throw new Error(`Nginx validate failed: ${(val.stderr || val.stdout).trim()}`);
      }
      const rel = spawnSync(nginxBin, ['-s', 'reload'], { encoding: 'utf8', timeout: 10000 });
      if (rel.status !== 0) {
        restorePreviousSite();
        throw new Error(`Nginx reload failed: ${(rel.stderr || rel.stdout).trim()}`);
      }
    }

    catalog.projects = catalog.projects.filter((p) => p.id !== projectId);
    catalog.projects.push(projectEntry);
    writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 0o644);

    const portSuffix =
      cfg.gatewayStrategy === 'dedicated-port'
        ? scheme === 'https'
          ? cfg.gatewayHttpsPort && cfg.gatewayHttpsPort !== 443
            ? `:${cfg.gatewayHttpsPort}`
            : ''
          : cfg.gatewayHttpPort && cfg.gatewayHttpPort !== 80
            ? `:${cfg.gatewayHttpPort}`
            : ''
        : '';
    const urls = Array.from(
      new Set(ingressRules.flatMap((r) => r.match.hosts.map((h) => `${r.match.scheme || 'http'}://${h}${portSuffix}`))),
    );
    return { projectId, name, owner, urls, siteFile };
  });
}

export function unpublishApp(cfg: VibeDockConfig, rawId: string, options: { skipCaddyReload?: boolean } = {}) {
  const lockFile = path.join(cfg.paths.dataDir, 'publish.lock');
  return withFileLock(lockFile, () => {
    const slug = normalizeSlug(rawId, cfg.appPrefix);
    const projectId = `${cfg.appPrefix}${slug}`;
    const { catalogPath, catalog } = loadCatalog(cfg);
    const existing = catalog.projects.find((p) => p.id === projectId);
    if (!existing) {
      throw new Error(`Project ${projectId} not found in catalog`);
    }

    const gateway = cfg.gateway || 'caddy';
    const caddySiteFile = path.join(cfg.paths.caddySitesDir, `${projectId}.caddy`);
    const nginxSiteFile = path.join(
      cfg.paths.nginxSitesDir || path.join(cfg.paths.dataDir, 'nginx/sites'),
      `${projectId}.conf`,
    );
    fs.rmSync(caddySiteFile, { force: true });
    fs.rmSync(nginxSiteFile, { force: true });

    if (!options.skipCaddyReload && gateway === 'caddy' && fs.existsSync(cfg.paths.caddyConfig)) {
      spawnSync(cfg.paths.caddyBin, ['reload', '--config', cfg.paths.caddyConfig, '--adapter', 'caddyfile'], {
        encoding: 'utf8',
        timeout: 10000,
      });
    } else if (!options.skipCaddyReload && gateway === 'nginx' && fs.existsSync(cfg.paths.nginxConfig || '/etc/nginx/nginx.conf')) {
      spawnSync(cfg.paths.nginxBin || 'nginx', ['-s', 'reload'], {
        encoding: 'utf8',
        timeout: 10000,
      });
    }

    catalog.projects = catalog.projects.filter((p) => p.id !== projectId);
    writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 0o644);
    return { projectId, unpublished: true };
  });
}
