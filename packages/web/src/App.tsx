import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api';
import type { CatalogLayout, CatalogResponse, ProjectRecord, User, ViewTab } from './types';
import { AuthGate } from './components/AuthGate';
import { Header } from './components/Header';
import { PasswordModal } from './components/PasswordModal';
import { CatalogView } from './components/CatalogView';
import { ProjectDrawer } from './components/ProjectDrawer';
import { DeployView } from './components/DeployView';
import { AssistantView } from './components/AssistantView';
import { UsersView } from './components/UsersView';

function normalizeCatalogResponse(raw: any): CatalogResponse {
  const domainSuffix = raw?.environment?.domainSuffix || '127.0.0.1.nip.io';
  const projects: ProjectRecord[] = (raw?.projects || []).map((p: any) => {
    const firstRuleHost = p.ingressRules?.[0]?.match?.hosts?.[0];
    const domain = p.domain || firstRuleHost || `${p.id}.${domainSuffix}`;
    const scheme = p.ingressRules?.[0]?.match?.scheme || 'http';
    const entryUrl = p.entryUrl || `${scheme}://${domain}`;
    const routes =
      p.routes ||
      (p.ingressRules || []).map((r: any) => {
        const host = r.match?.hosts?.[0] || domain;
        const pathPart = (r.match?.paths?.[0] || '/').replace(/\*$/, '');
        return {
          label: r.name || r.id || '入口',
          url: `${r.match?.scheme || 'http'}://${host}${pathPart}`,
        };
      });
    const components = (p.components || []).map((c: any) => {
      const firstPort = c.port ?? c.listeners?.[0]?.port ?? null;
      return {
        id: c.id,
        name: c.name,
        kind: c.type === 'static' || c.kind === 'static' ? 'static' : 'service',
        port: firstPort,
        status: c.online === false ? 'degraded' : 'online',
        entryUrl,
        deployTarget: c.deployTarget || c.staticRoot || c.processName || '-',
        summary: c.summary || c.role || c.runtime || '',
        runtimeCommand: c.runtimeCommand,
      };
    });
    return {
      id: p.id,
      name: p.name,
      category: p.category || '平台与团队应用',
      owner: p.owner || 'Team',
      status: p.status || 'online',
      updatedAt: p.updatedAt || (raw?.generatedAt ? raw.generatedAt.slice(0, 10) : '-'),
      domain,
      entryUrl,
      summary: p.summary || p.description || '',
      tags: p.tags || [],
      routes,
      components,
      caddyConfig: p.caddyConfig || '',
      healthState: p.status === 'degraded' ? 'offline' : 'online',
    };
  });

  const categories = Array.from(new Set(projects.map((p) => p.category).filter(Boolean)));
  const databases = (raw?.dx?.databases || raw?.databases || []).map((db: any) => ({
    type: db.id || db.type,
    name: db.name,
    host: db.host || '127.0.0.1',
    port: db.port,
    container: db.container || `vibedock-${db.id || db.type}`,
    status: db.online ? 'online' : 'standby',
    summary: db.notes || db.summary || db.engine || '',
  }));

  return {
    environment: {
      name: raw?.environment?.name || 'VibeDock Server',
      host: raw?.environment?.address || '127.0.0.1',
      domainSuffix,
      skillUrl: raw?.dx?.skillPackageUrl || '/api/dx/skill-package',
      allocatedPortRange: raw?.dx?.portPool?.range || '40000–40999',
    },
    summary: {
      projectCount: projects.length,
      serviceCount: raw?.summary?.listeners || 0,
      staticCount: raw?.summary?.staticComponents || 0,
      allocatedPorts: (raw?.dx?.portPool?.usedPorts || []).map((u: any) => u.port),
      nextSuggestedPort: raw?.dx?.portPool?.nextAvailablePort || 40000,
    },
    usedPorts: raw?.dx?.portPool?.usedPorts || [],
    provisionedProjects: raw?.dx?.provisionedProjects || [],
    categories,
    databases,
    projects,
  };
}

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeView, setActiveView] = useState<ViewTab>('catalog');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [layout, setLayout] = useState<CatalogLayout>('cards');
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [assistantInitialPrompt, setAssistantInitialPrompt] = useState<string | undefined>();

  const loadCatalog = useCallback(async () => {
    try {
      const raw = await apiFetch<any>('/api/catalog');
      setCatalog(normalizeCatalogResponse(raw));
    } catch {
      // ignore if unauthenticated
    }
  }, []);

  useEffect(() => {
    apiFetch<{ authenticated: boolean; user: User | null }>('/api/auth/session')
      .then((res) => {
        if (res.authenticated && res.user) {
          setUser(res.user);
        }
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (user) {
      loadCatalog();
    }
  }, [user, loadCatalog]);

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      // ignore
    }
    setUser(null);
    setCatalog(null);
  };

  if (!authChecked) {
    return null;
  }

  if (!user) {
    return <AuthGate onAuthenticated={(u) => setUser(u)} />;
  }

  const projects = catalog?.projects || [];
  const onlineCount = projects.filter((p) => p.healthState !== 'offline').length;

  return (
    <div id="portal-shell" className="min-h-screen bg-zinc-50 text-zinc-900">
      <Header
        user={user}
        activeView={activeView}
        onSelectView={setActiveView}
        onlineCount={onlineCount}
        totalCount={projects.length}
        onOpenPasswordModal={() => setPasswordModalOpen(true)}
        onLogout={handleLogout}
      />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {activeView === 'catalog' && (
          <CatalogView
            projects={projects}
            categories={catalog?.categories || []}
            query={query}
            onChangeQuery={setQuery}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            layout={layout}
            onChangeLayout={setLayout}
            onRefresh={loadCatalog}
            onSelectProject={(proj) => setSelectedProject(proj)}
            onSwitchToDeploy={() => setActiveView('deploy')}
          />
        )}

        {activeView === 'deploy' && <DeployView catalog={catalog} />}

        {activeView === 'assistant' && (
          <AssistantView
            user={user}
            initialPrompt={assistantInitialPrompt}
            onConsumeInitialPrompt={() => setAssistantInitialPrompt(undefined)}
            onCatalogRefresh={loadCatalog}
          />
        )}

        {activeView === 'users' && user.role === 'admin' && <UsersView />}
      </main>

      <ProjectDrawer
        project={selectedProject}
        user={user}
        onClose={() => setSelectedProject(null)}
        onDiagnoseWithAi={(prompt) => {
          setAssistantInitialPrompt(prompt);
          setActiveView('assistant');
        }}
        onProjectUpdated={loadCatalog}
      />

      <PasswordModal open={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} />
    </div>
  );
};
