import net from 'node:net';
import type { CatalogListener, CatalogProject, IngressRule } from '../types.js';

export function listenerScope(listener: CatalogListener): 'local' | 'remote' {
  return listener.scope || 'local';
}

export function ingressScheme(rule: IngressRule): 'http' | 'https' {
  return rule.match.scheme || 'http';
}

export function upstreamAddress(listener: CatalogListener): string {
  const host = net.isIP(listener.host) === 6 ? `[${listener.host}]` : listener.host;
  const address = `${host}:${listener.port}`;
  if (listener.protocol === 'https') return `https://${address}`;
  return listenerScope(listener) === 'remote' && ['http', 'websocket'].includes(listener.protocol)
    ? `http://${address}`
    : address;
}

function getTarget(project: CatalogProject, rule: IngressRule) {
  const component = project.components.find((item) => item.id === rule.target.component)!;
  const listener = component.listeners.find((item) => item.id === rule.target.listener);
  return { component, listener };
}

function targetDirectives(project: CatalogProject, rule: IngressRule, indent = '\t'): string {
  const { component, listener } = getTarget(project, rule);
  if (component.type === 'static') {
    const lines = [`${indent}root * ${component.staticRoot}`];
    if (component.runtime && component.runtime.toLowerCase().includes('spa')) {
      lines.push(`${indent}try_files {path} /index.html`);
    }
    lines.push(`${indent}encode zstd gzip`, `${indent}file_server`);
    return lines.join('\n');
  }
  return `${indent}reverse_proxy ${upstreamAddress(listener!)}`;
}

export function buildCaddyConfig(project: CatalogProject): string {
  const rulesBySite = new Map<string, { scheme: string; host: string; rules: Array<{ rule: IngressRule; routePath: string }>; tls?: IngressRule['tls'] }>();

  for (const rule of project.ingressRules) {
    const scheme = ingressScheme(rule);
    for (const host of rule.match.hosts) {
      const siteKey = `${scheme}://${host}`;
      const site = rulesBySite.get(siteKey) || { scheme, host, rules: [], tls: rule.tls };
      for (const routePath of rule.match.paths) site.rules.push({ rule, routePath });
      rulesBySite.set(siteKey, site);
    }
  }

  return [...rulesBySite.values()]
    .map(({ scheme, host, rules, tls }) => {
      const sortedRules = rules.sort((left, right) => {
        if (left.routePath === '/*') return 1;
        if (right.routePath === '/*') return -1;
        return right.routePath.length - left.routePath.length;
      });
      const tlsDirective =
        tls?.certificateFile && tls?.keyFile
          ? `\n\ttls ${tls.certificateFile} ${tls.keyFile}`
          : '';

      if (sortedRules.length === 1 && sortedRules[0].routePath === '/*') {
        return `${scheme}://${host} {${tlsDirective}\n${targetDirectives(project, sortedRules[0].rule)}\n}`;
      }

      const handles = sortedRules.map(({ rule, routePath }) => {
        const matcher = routePath === '/*' ? '' : ` ${routePath}`;
        return `\thandle${matcher} {\n${targetDirectives(project, rule, '\t\t')}\n\t}`;
      });
      return `${scheme}://${host} {${tlsDirective}\n${handles.join('\n\n')}\n}`;
    })
    .join('\n\n');
}

export function buildNginxConfig(project: CatalogProject): string {
  const rulesBySite = new Map<
    string,
    { scheme: string; host: string; rules: Array<{ rule: IngressRule; routePath: string }>; tls?: IngressRule['tls'] }
  >();

  for (const rule of project.ingressRules) {
    const scheme = ingressScheme(rule);
    for (const host of rule.match.hosts) {
      const siteKey = `${scheme}://${host}`;
      const site = rulesBySite.get(siteKey) || { scheme, host, rules: [], tls: rule.tls };
      for (const routePath of rule.match.paths) site.rules.push({ rule, routePath });
      rulesBySite.set(siteKey, site);
    }
  }

  return [...rulesBySite.values()]
    .map(({ scheme, host, rules, tls }) => {
      const sortedRules = rules.sort((left, right) => {
        if (left.routePath === '/*') return 1;
        if (right.routePath === '/*') return -1;
        return right.routePath.length - left.routePath.length;
      });
      const hasSsl = Boolean(scheme === 'https' && tls?.certificateFile && tls?.keyFile);
      const headerLines = [
        'server {',
        hasSsl ? '  listen 443 ssl;' : '  listen 80;',
        `  server_name ${host};`,
      ];
      if (hasSsl) {
        headerLines.push(`  ssl_certificate ${tls!.certificateFile};`);
        headerLines.push(`  ssl_certificate_key ${tls!.keyFile};`);
      }

      const locations = sortedRules.map(({ rule, routePath }) => {
        const { component, listener } = getTarget(project, rule);
        const locPath = routePath === '/*' ? '/' : routePath.replace(/\*$/, '');
        if (component.type === 'static') {
          const lines = [`  location ${locPath} {`, `    root ${component.staticRoot};`];
          if (component.runtime && component.runtime.toLowerCase().includes('spa')) {
            lines.push('    try_files $uri $uri/ /index.html;');
          } else {
            lines.push('    index index.html;');
          }
          lines.push('  }');
          return lines.join('\n');
        }
        const hostAddr = net.isIP(listener!.host) === 6 ? `[${listener!.host}]` : listener!.host;
        const upstreamProto = listener!.protocol === 'https' ? 'https' : 'http';
        return [
          `  location ${locPath} {`,
          `    proxy_pass ${upstreamProto}://${hostAddr}:${listener!.port};`,
          '    proxy_http_version 1.1;',
          '    proxy_set_header Host $host;',
          '    proxy_set_header X-Real-IP $remote_addr;',
          '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
          '    proxy_set_header X-Forwarded-Proto $scheme;',
          '    proxy_set_header Upgrade $http_upgrade;',
          '    proxy_set_header Connection "upgrade";',
          '  }',
        ].join('\n');
      });

      return [...headerLines, ...locations, '}'].join('\n');
    })
    .join('\n\n');
}
