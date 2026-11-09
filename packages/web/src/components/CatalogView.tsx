import React, { useMemo, useRef, useEffect } from 'react';
import {
  Search,
  RefreshCw,
  LayoutGrid,
  List,
  ExternalLink,
  Globe,
  Cpu,
  User as UserIcon,
  FileCode,
} from 'lucide-react';
import type { CatalogLayout, HostSystemSummary, ProjectRecord } from '../types';
import { Badge, Button, Card, Input } from './ui';

interface CatalogViewProps {
  projects: ProjectRecord[];
  system?: HostSystemSummary | null;
  categories: string[];
  query: string;
  onChangeQuery: (q: string) => void;
  selectedCategory: string;
  onSelectCategory: (cat: string) => void;
  layout: CatalogLayout;
  onChangeLayout: (layout: CatalogLayout) => void;
  onRefresh: () => void;
  onSelectProject: (project: ProjectRecord) => void;
  onSwitchToDeploy: () => void;
}

export const CatalogView: React.FC<CatalogViewProps> = ({
  projects,
  system,
  categories,
  query,
  onChangeQuery,
  selectedCategory,
  onSelectCategory,
  layout,
  onChangeLayout,
  onRefresh,
  onSelectProject,
  onSwitchToDeploy,
}) => {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((proj) => {
      const catMatch = selectedCategory === '全部' || proj.category === selectedCategory;
      if (!catMatch) return false;
      if (!q) return true;
      const haystack = [
        proj.id,
        proj.name,
        proj.owner,
        proj.category,
        proj.domain,
        proj.summary,
        ...(proj.tags || []),
        ...(proj.components || []).map((c) => `${c.name} ${c.port ?? ''}`),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [projects, query, selectedCategory]);

  const allCategories = useMemo(() => ['全部', ...categories], [categories]);

  return (
    <section className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
            <Input
              ref={searchRef}
              type="search"
              className="pl-9"
              placeholder="搜索项目、域名、端口或负责人… (按 /)"
              value={query}
              onChange={(e) => onChangeQuery(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="tablist">
            {allCategories.map((cat) => {
              const active = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => onSelectCategory(cat)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                    active
                      ? 'bg-zinc-900 text-white shadow-2xs'
                      : 'bg-white text-zinc-600 border border-zinc-200 hover:bg-zinc-100 hover:text-zinc-900'
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新状态
          </Button>
          <div className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5 shadow-2xs">
            <button
              type="button"
              onClick={() => onChangeLayout('cards')}
              className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                layout === 'cards'
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              卡片
            </button>
            <button
              type="button"
              onClick={() => onChangeLayout('table')}
              className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                layout === 'table'
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <List className="h-3.5 w-3.5" />
              列表
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {filteredProjects.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <h3 className="text-base font-semibold text-zinc-900">没有找到匹配的应用项目</h3>
          <p className="mt-1 max-w-md text-xs text-zinc-500">
            {projects.length === 0
              ? '当前门户尚未发布任何项目。前往「开发者中心」使用 AI Skill 一键把本地项目推上线。'
              : '请尝试清空搜索词或切换其他分类标签。'}
          </p>
          {projects.length === 0 && (
            <Button className="mt-4" onClick={onSwitchToDeploy}>
              前往开发者中心接入首个项目 →
            </Button>
          )}
        </Card>
      ) : layout === 'cards' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => {
            const ports = (project.components || [])
              .map((c) => c.port)
              .filter((p): p is number => typeof p === 'number');
            const isOnline = project.healthState !== 'offline';
            const isMonitorCard =
              /^(?:team-)?(?:beszel|host-monitor|server-monitor)$/i.test(project.id) &&
              Boolean(system && typeof system.cpuPercent === 'number');
            return (
              <Card
                key={project.id}
                onClick={() => onSelectProject(project)}
                className="group flex flex-col justify-between p-5 transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md cursor-pointer"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">
                        {project.category || '未分类'}
                      </span>
                      <h3 className="mt-0.5 text-base font-semibold text-zinc-900 group-hover:text-blue-600 transition-colors">
                        {project.name}
                      </h3>
                    </div>
                    <Badge variant={isOnline ? 'success' : 'danger'}>
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isOnline ? 'bg-emerald-500' : 'bg-red-500'
                        }`}
                      />
                      {isOnline ? '在线' : '离线'}
                    </Badge>
                  </div>

                  {isMonitorCard && system ? (
                    <a
                      href={project.entryUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="点击打开 Beszel 主机监控面板"
                      className="mt-3 grid grid-cols-3 gap-2"
                    >
                      <div className="rounded-md border border-zinc-200/80 bg-zinc-50/80 px-2.5 py-2">
                        <div className="flex items-baseline justify-between gap-1">
                          <span className="text-[11px] font-medium text-zinc-600 whitespace-nowrap">CPU</span>
                          <span className="font-mono text-[10px] text-zinc-400 whitespace-nowrap">
                            {system.cpuCores || 8}核
                          </span>
                        </div>
                        <div className="mt-0.5 mb-1.5 font-mono text-sm font-bold text-zinc-900 whitespace-nowrap">
                          {system.cpuPercent}%
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-200/80">
                          <div
                            className={`h-full rounded-full ${
                              system.cpuPercent >= 85
                                ? 'bg-red-500'
                                : system.cpuPercent >= 70
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.max(4, Math.min(100, system.cpuPercent))}%` }}
                          />
                        </div>
                      </div>

                      <div className="rounded-md border border-zinc-200/80 bg-zinc-50/80 px-2.5 py-2">
                        <div className="flex items-baseline justify-between gap-1">
                          <span className="text-[11px] font-medium text-zinc-600 whitespace-nowrap">内存</span>
                          <span className="font-mono text-[10px] text-zinc-400 whitespace-nowrap">
                            {(system.memoryUsedBytes / 1024 ** 3).toFixed(1)}/
                            {(system.memoryTotalBytes / 1024 ** 3).toFixed(0)}G
                          </span>
                        </div>
                        <div className="mt-0.5 mb-1.5 font-mono text-sm font-bold text-zinc-900 whitespace-nowrap">
                          {system.memoryPercent}%
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-200/80">
                          <div
                            className={`h-full rounded-full ${
                              system.memoryPercent >= 85
                                ? 'bg-red-500'
                                : system.memoryPercent >= 75
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.max(4, Math.min(100, system.memoryPercent))}%` }}
                          />
                        </div>
                      </div>

                      <div className="rounded-md border border-zinc-200/80 bg-zinc-50/80 px-2.5 py-2">
                        <div className="flex items-baseline justify-between gap-1">
                          <span className="text-[11px] font-medium text-zinc-600 whitespace-nowrap">磁盘</span>
                          <span className="font-mono text-[10px] text-zinc-400 whitespace-nowrap">
                            {(system.diskUsedBytes / 1024 ** 3).toFixed(0)}/
                            {(system.diskTotalBytes / 1024 ** 3).toFixed(0)}G
                          </span>
                        </div>
                        <div className="mt-0.5 mb-1.5 font-mono text-sm font-bold text-zinc-900 whitespace-nowrap">
                          {system.diskPercent}%
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-200/80">
                          <div
                            className={`h-full rounded-full ${
                              system.diskPercent >= 85
                                ? 'bg-red-500'
                                : system.diskPercent >= 75
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.max(4, Math.min(100, system.diskPercent))}%` }}
                          />
                        </div>
                      </div>
                    </a>
                  ) : (
                    <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-zinc-600">
                      {project.summary || '暂无项目简介'}
                    </p>
                  )}

                  <div className="mt-4 flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="font-mono text-[11px]">
                      <Globe className="h-3 w-3 text-zinc-400" />
                      {project.domain}
                    </Badge>
                    {ports.length > 0 ? (
                      <Badge variant="outline" className="font-mono text-[11px]">
                        <Cpu className="h-3 w-3 text-zinc-400" />:{ports.join(', :')}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[11px]">
                        <FileCode className="h-3 w-3 text-zinc-400" />
                        纯静态站点
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-[11px]">
                      <UserIcon className="h-3 w-3 text-zinc-400" />
                      {project.owner || 'Team'}
                    </Badge>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-3">
                  <div className="flex flex-wrap gap-1">
                    {(project.tags || []).slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <a
                      href={project.entryUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white shadow-2xs hover:bg-zinc-800 transition-colors"
                    >
                      打开应用
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50/80 text-zinc-500">
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">项目名称</th>
                  <th className="px-4 py-3 font-medium">分类</th>
                  <th className="px-4 py-3 font-medium">域名</th>
                  <th className="px-4 py-3 font-medium">端口</th>
                  <th className="px-4 py-3 font-medium">负责人</th>
                  <th className="px-4 py-3 font-medium">更新日期</th>
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {filteredProjects.map((project) => {
                  const ports = (project.components || [])
                    .map((c) => c.port)
                    .filter((p): p is number => typeof p === 'number');
                  const isOnline = project.healthState !== 'offline';
                  return (
                    <tr
                      key={project.id}
                      onClick={() => onSelectProject(project)}
                      className="hover:bg-zinc-50/80 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Badge variant={isOnline ? 'success' : 'danger'}>
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              isOnline ? 'bg-emerald-500' : 'bg-red-500'
                            }`}
                          />
                          {isOnline ? '在线' : '离线'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-zinc-900">{project.name}</div>
                        <div className="font-mono text-[11px] text-zinc-400">{project.id}</div>
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{project.category}</td>
                      <td className="px-4 py-3 font-mono text-zinc-700">{project.domain}</td>
                      <td className="px-4 py-3 font-mono text-zinc-600">
                        {ports.length > 0 ? ports.map((p) => `:${p}`).join(', ') : '静态'}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{project.owner}</td>
                      <td className="px-4 py-3 text-zinc-500">{project.updatedAt}</td>
                      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <a
                          href={project.entryUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 shadow-2xs hover:bg-zinc-100"
                        >
                          访问 <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
};
