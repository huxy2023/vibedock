import type { ActionMetadata, CatalogData, CatalogProject } from '../../types.js';

function normalize(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function projectText(project: CatalogProject): string {
  return [
    project.id,
    project.name,
    project.shortName,
    project.description,
    ...(project.aliases || []),
    ...(project.tags || []),
    ...project.components.flatMap((component) => [
      component.id,
      component.name,
      component.role,
      component.processName,
      ...component.listeners.flatMap((listener) => [listener.port, listener.protocol]),
    ]),
    ...project.ingressRules.flatMap((rule) => [rule.name, rule.match.protocol, ...rule.match.hosts, ...rule.match.paths]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function findProjects(snapshot: CatalogData, query: string): CatalogProject[] {
  const normalized = normalize(query);
  const identityMatches = snapshot.projects.filter((project) =>
    [project.id, project.name, project.shortName, ...(project.aliases || [])]
      .filter(Boolean)
      .some((identity) => normalized.includes(normalize(identity))),
  );
  if (identityMatches.length) return identityMatches;
  const terms = normalized.split(/\s+/).filter((term) => term.length > 1);
  return snapshot.projects.filter((project) => terms.some((term) => projectText(project).includes(term)));
}

export function deterministicAnswer(
  snapshot: CatalogData,
  question: string,
  actions: Array<Pick<ActionMetadata, 'id' | 'projectId' | 'kind'>>,
) {
  const query = normalize(question);
  const matched = findProjects(snapshot, query);
  const degraded = snapshot.projects.filter((project) => project.status !== 'online');
  let answer: string;
  let focused = matched;
  const asksPorts = /端口|监听/.test(query);
  const asksIngress = /域名|地址|入口|路由|路径|访问/.test(query);

  if (focused.length && asksPorts && asksIngress) {
    answer = focused
      .map((project) => {
        const listeners = project.components.flatMap((component) =>
          component.listeners.map((listener) => `  - ${component.name}: ${listener.host}:${listener.port} (${listener.protocol})`),
        );
        const routes = project.ingressRules.flatMap((rule) =>
          rule.match.hosts.flatMap((host) =>
            rule.match.paths.map((routePath) => {
              const component = project.components.find((item) => item.id === rule.target.component);
              return `  - ${rule.match.protocol.toUpperCase()} ${host}${routePath === '/*' ? '/' : routePath} → ${component?.name || rule.target.component}`;
            }),
          ),
        );
        return `${project.name}\n内部监听：\n${listeners.length ? listeners.join('\n') : '  - 无（Caddy 直接托管）'}\n访问入口：\n${routes.join('\n')}`;
      })
      .join('\n\n');
  } else if (/异常|故障|离线|健康|状态/.test(query)) {
    const statusTargets = focused.length ? focused : degraded;
    answer = statusTargets.length
      ? `${focused.length ? '目标项目状态' : `发现 ${statusTargets.length} 个异常项目`}：${statusTargets.map((project) => `${project.name}（${project.status === 'online' ? '在线' : '异常'}）`).join('、')}。${statusTargets.some((project) => project.status !== 'online') ? '建议先运行综合诊断，再查看对应进程状态。' : ''}`
      : `当前 ${snapshot.summary?.projects ?? snapshot.projects.length} 个项目均在线，${snapshot.summary?.onlineListeners ?? 0}/${snapshot.summary?.listeners ?? 0} 个内部监听器可连接，未发现端口冲突。`;
    focused = statusTargets;
  } else if (asksPorts) {
    const projects = focused.length ? focused : snapshot.projects;
    const rows = projects.flatMap((project) =>
      project.components.flatMap((component) =>
        component.listeners.map((listener) => `${project.name} / ${component.name}: ${listener.host}:${listener.port}`),
      ),
    );
    answer = rows.length
      ? `目录登记的监听关系：\n${rows.map((row) => `- ${row}`).join('\n')}`
      : '匹配项目由 Caddy 直接托管静态文件，没有内部监听端口。';
  } else if (asksIngress) {
    const projects = focused.length ? focused : snapshot.projects;
    const rows = projects.flatMap((project) =>
      project.ingressRules.flatMap((rule) =>
        rule.match.hosts.flatMap((host) =>
          rule.match.paths.map(
            (routePath) =>
              `${rule.match.protocol.toUpperCase()} ${host}${routePath === '/*' ? '/' : routePath} → ${project.name} / ${rule.target.component}.${rule.target.listener || 'static'}`,
          ),
        ),
      ),
    );
    answer = `入口关系：\n${rows.slice(0, 12).map((row) => `- ${row}`).join('\n')}${rows.length > 12 ? `\n- 另有 ${rows.length - 12} 条` : ''}`;
  } else if (/websocket|web socket|\bws\b|实时/.test(query)) {
    const projects = snapshot.projects.filter((project) =>
      project.ingressRules.some((rule) => rule.match.protocol === 'websocket'),
    );
    focused = projects;
    answer = projects.length
      ? `WebSocket 服务：${projects.map((project) => project.ingressRules.filter((rule) => rule.match.protocol === 'websocket').map((rule) => `${project.name}（${rule.match.hosts[0]}${rule.match.paths[0]}）`).join('、')).join('、')}。`
      : '当前目录没有登记 WebSocket 入口。';
  } else if (focused.length === 1) {
    const project = focused[0];
    const ports = project.components.flatMap((component) => component.listeners.map((listener) => listener.port));
    const hosts = [...new Set(project.ingressRules.flatMap((rule) => rule.match.hosts))];
    answer = `${project.name}当前${project.status === 'online' ? '在线' : '异常'}，包含 ${project.components.length} 个组件${ports.length ? `，内部端口 ${ports.join('、')}` : '，由 Caddy 直接托管静态文件'}。访问入口：${hosts.join('、')}。`;
  } else {
    answer = `当前目录包含 ${snapshot.summary?.projects ?? snapshot.projects.length} 个项目、${snapshot.summary?.components ?? 0} 个组件、${snapshot.summary?.listeners ?? 0} 个监听器和 ${snapshot.summary?.ingressRules ?? 0} 条入口规则。`;
  }

  const projectIds = focused.slice(0, 3).map((project) => project.id);
  const preferredKinds = /日志/.test(query)
    ? ['logs']
    : /重启/.test(query)
    ? ['restart']
    : /状态/.test(query)
    ? ['status', 'diagnose']
    : ['diagnose', 'status'];
  const suggestions = actions
    .filter((action) => (!projectIds.length || (action.projectId && projectIds.includes(action.projectId))) && preferredKinds.includes(action.kind))
    .sort((left, right) => preferredKinds.indexOf(left.kind) - preferredKinds.indexOf(right.kind))
    .slice(0, 3)
    .map((action) => action.id);

  return {
    mode: 'catalog' as const,
    providerLabel: '目录智能检索',
    answer,
    projectIds,
    suggestions,
    actionReasons: {} as Record<string, string>,
  };
}
