import React, { useState } from 'react';
import {
  X,
  ExternalLink,
  Sparkles,
  Activity,
  FileText,
  RotateCw,
  Server,
} from 'lucide-react';
import { apiFetch } from '../api';
import type { ProjectRecord, User } from '../types';
import { Badge, Button } from './ui';

interface ProjectDrawerProps {
  project: ProjectRecord | null;
  user: User;
  onClose: () => void;
  onDiagnoseWithAi: (prompt: string) => void;
  onProjectUpdated: () => void;
}

export const ProjectDrawer: React.FC<ProjectDrawerProps> = ({
  project,
  user,
  onClose,
  onDiagnoseWithAi,
  onProjectUpdated,
}) => {
  const [actionStatus, setActionStatus] = useState('');
  const [actionOutput, setActionOutput] = useState('');
  const [loading, setLoading] = useState(false);

  if (!project) return null;

  const isOnline = project.healthState !== 'offline';
  const serviceComp = (project.components || []).find((c) => c.kind === 'service');

  const runControlledAction = async (kind: 'status' | 'logs' | 'restart') => {
    if (!serviceComp) return;
    setLoading(true);
    const labelMap = {
      status: '正在读取进程状态…',
      logs: '正在读取最近日志…',
      restart: '正在重启应用进程…',
    };
    setActionStatus(labelMap[kind]);
    setActionOutput('');
    try {
      const actionId = `${project.id}:${serviceComp.id}:${kind}`;
      const res = await apiFetch<{
        summary?: string;
        status?: string;
        output?: string;
        stdout?: string;
        stderr?: string;
      }>(`/api/actions/${encodeURIComponent(actionId)}/execute`, {
        method: 'POST',
        body: JSON.stringify({
          confirmed: true,
          reason: `管理员从项目详情面板执行 ${kind} (${project.name})`,
        }),
      });
      setActionStatus(res.summary || '执行完成');
      const combined = (res.output || [res.stdout, res.stderr].filter(Boolean).join('\n')).trim();
      if (combined) {
        setActionOutput(combined);
      }
      if (kind === 'restart') {
        onProjectUpdated();
      }
    } catch (err) {
      setActionStatus(`操作失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-zinc-950/40 backdrop-blur-2xs"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-xl flex-col border-l border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-zinc-200 px-6 py-4">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">
              {project.category || '未分类'}
            </span>
            <h2 className="mt-0.5 text-lg font-semibold text-zinc-900">{project.name}</h2>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 cursor-pointer"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <p className="text-xs leading-relaxed text-zinc-600">
            {project.summary || '暂无简介'}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3">
              <span className="block text-[11px] font-medium text-zinc-500">项目 ID</span>
              <code className="mt-1 block text-xs font-semibold text-zinc-900">{project.id}</code>
            </div>
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3">
              <span className="block text-[11px] font-medium text-zinc-500">负责人</span>
              <span className="mt-1 block text-xs font-semibold text-zinc-900">
                {project.owner || 'Team'}
              </span>
            </div>
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3">
              <span className="block text-[11px] font-medium text-zinc-500">访问域名</span>
              <code className="mt-1 block truncate text-xs font-semibold text-zinc-900">
                {project.domain}
              </code>
            </div>
            <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3">
              <span className="block text-[11px] font-medium text-zinc-500">在线探测</span>
              <div className="mt-1">
                <Badge variant={isOnline ? 'success' : 'danger'}>
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isOnline ? 'bg-emerald-500' : 'bg-red-500'
                    }`}
                  />
                  {isOnline ? '在线正常' : '离线/未响应'}
                </Badge>
              </div>
            </div>
          </div>

          <div className="space-y-2.5 border-t border-zinc-100 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              快速访问入口
            </h3>
            <div className="space-y-2">
              {(project.routes || [{ label: '主入口', url: project.entryUrl }]).map(
                (route, idx) => (
                  <a
                    key={idx}
                    href={route.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50/60 px-3.5 py-2.5 text-xs transition-colors hover:border-zinc-300 hover:bg-zinc-100/70"
                  >
                    <span className="font-medium text-zinc-800">{route.label}</span>
                    <span className="inline-flex items-center gap-1 font-mono text-blue-600">
                      {route.url}
                      <ExternalLink className="h-3 w-3" />
                    </span>
                  </a>
                )
              )}
            </div>
          </div>

          <div className="space-y-2.5 border-t border-zinc-100 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              部署组件与槽位
            </h3>
            <div className="space-y-2.5">
              {(project.components || []).map((comp) => (
                <div
                  key={comp.id}
                  className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-semibold text-xs text-zinc-900">
                      <Server className="h-3.5 w-3.5 text-zinc-500" />
                      {comp.name}
                    </div>
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {comp.kind === 'service' ? `常驻进程 :${comp.port}` : '静态站点'}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs text-zinc-500">{comp.summary}</p>
                  <div className="mt-2 space-y-1 font-mono text-[11px] text-zinc-600">
                    <div>目标: {comp.deployTarget}</div>
                    {comp.runtimeCommand && <div>启动: {comp.runtimeCommand}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {project.caddyConfig && (
            <div className="border-t border-zinc-100 pt-5">
              <details className="group">
                <summary className="cursor-pointer text-xs font-semibold text-zinc-700 hover:text-zinc-900">
                  查看 Caddy 网关路由配置片段
                </summary>
                <pre className="mt-2.5 overflow-x-auto rounded-lg bg-zinc-950 p-3.5 text-xs text-zinc-100">
                  {project.caddyConfig}
                </pre>
              </details>
            </div>
          )}

          <div className="space-y-3 border-t border-zinc-100 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              运维与 AI 诊断
            </h3>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onClose();
                  onDiagnoseWithAi(
                    `帮我检查项目 ${project.name} (${project.id}) 的部署状态、端口与进程健康度`
                  );
                }}
              >
                <Sparkles className="h-3.5 w-3.5" />
                让 AI 助手诊断该项目
              </Button>
              {user.role === 'admin' && serviceComp && project.id !== 'vibedock-portal' && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => runControlledAction('status')}
                  >
                    <Activity className="h-3.5 w-3.5" />
                    进程状态
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => runControlledAction('logs')}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    最近日志
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => runControlledAction('restart')}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    重启 PM2
                  </Button>
                </>
              )}
            </div>
            {actionStatus && <p className="text-xs text-zinc-600">{actionStatus}</p>}
            {actionOutput && (
              <pre className="max-h-56 overflow-y-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
                {actionOutput}
              </pre>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};
