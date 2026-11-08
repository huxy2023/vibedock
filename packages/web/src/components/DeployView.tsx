import React, { useState } from 'react';
import { Download, Copy, Check, Database } from 'lucide-react';
import type { CatalogResponse } from '../types';
import { Badge, Button, Card, Input, Select } from './ui';

interface DeployViewProps {
  catalog: CatalogResponse | null;
}

export const DeployView: React.FC<DeployViewProps> = ({ catalog }) => {
  const [appId, setAppId] = useState('my-team-app');
  const [appName, setAppName] = useState('团队新工具');
  const [category] = useState('工具');
  const [owner] = useState('Team');
  const [kind, setKind] = useState<'fullstack' | 'service' | 'static' | 'external'>('fullstack');
  const [runtime, setRuntime] = useState<'node' | 'python' | 'go'>('node');
  const [upstreamUrl, setUpstreamUrl] = useState('http://127.0.0.1:8080');
  const [selectedDbs, setSelectedDbs] = useState<string[]>([]);
  const [copiedKey, setCopiedKey] = useState('');

  const env = catalog?.environment;
  const summary = catalog?.summary;
  const databases = catalog?.databases || [];
  const usedPorts = catalog?.usedPorts || [];
  const provisionedProjects = catalog?.provisionedProjects || [];
  const domainSuffix = env?.domainSuffix || '127.0.0.1.nip.io';
  const nextPort = summary?.nextSuggestedPort || 40000;
  const skillDownloadUrl = env?.skillUrl || '/api/dx/skill-package';
  const skillInstallCmd =
    env?.skillCommand ||
    `mkdir -p ~/.claude/skills && curl -fsSL "${
      skillDownloadUrl.startsWith('http')
        ? skillDownloadUrl
        : `${window.location.origin}${skillDownloadUrl}`
    }" -o /tmp/vibedock-deploy.zip && unzip -qo /tmp/vibedock-deploy.zip -d ~/.claude/skills/`;

  const toggleDb = (dbType: string) => {
    setSelectedDbs((prev) =>
      prev.includes(dbType) ? prev.filter((item) => item !== dbType) : [...prev, dbType]
    );
  };

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const runtimeDefaultCmd =
    runtime === 'python'
      ? 'uvicorn main:app --host 127.0.0.1 --port ${PORT}'
      : runtime === 'go'
      ? './server'
      : 'node server.js';

  const slug = appId || 'my-team-app';
  const components =
    kind === 'fullstack'
      ? [
          { id: 'web', kind: 'static', root: 'web', routing: 'spa' },
          { id: 'api', kind: 'service', runtime, port: nextPort, command: runtimeDefaultCmd },
        ]
      : kind === 'service'
      ? [{ id: 'api', kind: 'service', runtime, port: nextPort, command: runtimeDefaultCmd }]
      : kind === 'external'
      ? [{ id: 'upstream', kind: 'external', upstream: upstreamUrl || 'http://127.0.0.1:8080' }]
      : [{ id: 'web', kind: 'static', root: 'web', routing: 'spa' }];

  const routes =
    kind === 'fullstack'
      ? [
          { component: 'api', host: 'main', path: '/api/*' },
          { component: 'web', host: 'main', path: '/*' },
        ]
      : [
          {
            component: kind === 'service' ? 'api' : kind === 'external' ? 'upstream' : 'web',
            host: 'main',
            path: '/*',
          },
        ];

  const manifestPreview = JSON.stringify(
    {
      id: slug,
      name: appName || '团队新工具',
      category: category || '工具',
      owner: owner || 'Team',
      description: `${appName || '团队新工具'}（通过 VibeDock 自动接入）`,
      components,
      routes,
      ...(selectedDbs.length > 0 ? { databases: selectedDbs } : {}),
    },
    null,
    2
  );

  const allocCmd = `node ~/.claude/skills/vibedock-deploy/scripts/client.mjs alloc ${slug}`;
  const dbProvisionCmd =
    selectedDbs.length > 0
      ? `\nnode ~/.claude/skills/vibedock-deploy/scripts/client.mjs db provision ${slug} --types ${selectedDbs.join(',')}`
      : '';

  const aiPromptPreview =
    kind === 'external'
      ? [
          `请使用 vibedock-deploy Skill 一键纳管已有存量服务并挂载子域名与门户卡片：`,
          `node ~/.claude/skills/vibedock-deploy/scripts/client.mjs adopt ${slug} --upstream "${upstreamUrl || 'http://127.0.0.1:8080'}" --name "${appName || '团队新工具'}" --owner "${owner || 'Team'}"`,
        ].join('\n')
      : [
          `请使用 vibedock-deploy Skill 将当前项目部署到团队服务器：`,
          `- 项目 ID: ${slug}`,
          `- 项目名称: ${appName || '团队新工具'}`,
          `- 分类: ${category || '工具'} / 负责人: ${owner || 'Team'}`,
          `- 部署形态: ${
            kind === 'fullstack'
              ? `前后端一体 (web 静态前端 /* + api 后端服务 /api/*, Runtime: ${runtime})`
              : kind === 'service'
              ? `后端/全栈常驻服务 (${runtime})`
              : '纯静态前端站点'
          }`,
          selectedDbs.length > 0
            ? `- 需要自动开通并注入环境变量的数据库: ${selectedDbs.join(', ')}`
            : `- 数据库需求: 无需共享数据库`,
          `请先执行以下命令分配固定端口${selectedDbs.length > 0 ? '与数据库' : ''}：\n${allocCmd}${dbProvisionCmd}`,
          `然后上传产物并调用 publish 发布上线。`,
        ].join('\n');

  return (
    <section className="space-y-6">
      <Card className="flex flex-col justify-between gap-4 p-6 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">
            通过 AI Skill 零配置接入服务器与数据库
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            安装一次 Skill 包，对 Claude Code / Codex / Cursor 说句话即可自动分配独立子域名（*.
            {domainSuffix}）、端口（{env?.allocatedPortRange || '40000–40999'}）与专属数据库。
          </p>
        </div>
        <div className="flex flex-col items-start rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2.5 sm:items-end">
          <span className="text-[11px] font-medium text-zinc-500">下个推荐空闲端口</span>
          <strong className="font-mono text-xl font-bold text-zinc-900">{nextPort}</strong>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col justify-between p-6">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <Badge variant="default" className="font-mono">
                STEP 1
              </Badge>
              <h3 className="text-base font-semibold text-zinc-900">
                下载并安装 VibeDock Deploy Skill
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-zinc-600">
              包内已内置服务器 SSH 免密部署密钥与统一的零依赖 Node ESM 客户端（
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-zinc-800">
                scripts/client.mjs
              </code>
              ）。
            </p>

            <div className="flex flex-wrap gap-2">
              <a
                href={skillDownloadUrl}
                download="vibedock-deploy.zip"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-zinc-800 transition-colors"
              >
                <Download className="h-4 w-4" />
                下载 vibedock-deploy.zip
              </a>
              <Button
                type="button"
                variant="outline"
                onClick={() => copyText('skill-cmd', skillInstallCmd)}
              >
                {copiedKey === 'skill-cmd' ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-600" />
                    已复制安装命令
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    复制终端一键安装命令
                  </>
                )}
              </Button>
            </div>

            <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3.5 text-xs text-zinc-100">
              {skillInstallCmd}
            </pre>
          </div>

          {usedPorts.length > 0 && (
            <div className="mt-6 border-t border-zinc-100 pt-4">
              <span className="mb-2 block text-xs font-medium text-zinc-500">
                当前已分配团队端口 ({usedPorts.length})：
              </span>
              <div className="flex flex-wrap gap-1.5">
                {usedPorts.map((u) => (
                  <Badge
                    key={`${u.projectId}-${u.port}`}
                    variant="outline"
                    className="font-mono text-[11px]"
                  >
                    :{u.port} → {u.projectName} ({u.componentName})
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-6">
          <div className="flex items-center gap-2.5">
            <Badge variant="default" className="font-mono">
              STEP 2
            </Badge>
            <h3 className="text-base font-semibold text-zinc-900">
              生成 AI 一键部署指令与 publish.json
            </h3>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-700">项目 ID（子域名前缀）</label>
              <Input
                type="text"
                value={appId}
                onChange={(e) =>
                  setAppId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                }
                placeholder="my-team-app"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-700">项目名称</label>
              <Input
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="团队新工具"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-700">部署架构形态</label>
              <Select
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as 'fullstack' | 'service' | 'static' | 'external')
                }
              >
                <option value="fullstack">前后端一体 (静态前端 /* + 后端服务 /api/*)</option>
                <option value="service">纯后端/全栈单进程服务 (PM2 守护 + 反代)</option>
                <option value="static">纯静态前端站点 (网关直接托管)</option>
                <option value="external">存量服务纳管 (本机/内网已有端口一键挂入网关)</option>
              </Select>
            </div>
            {kind === 'external' ? (
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700">存量服务上游地址 (Upstream)</label>
                <Input
                  type="text"
                  value={upstreamUrl}
                  onChange={(e) => setUpstreamUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8080"
                />
              </div>
            ) : (
              kind !== 'static' && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-zinc-700">服务端语言栈 (Runtime)</label>
                  <Select
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value as 'node' | 'python' | 'go')}
                  >
                    <option value="node">Node.js / TypeScript (Hono / Express / Next)</option>
                    <option value="python">Python (FastAPI / Uvicorn / Flask)</option>
                    <option value="go">Go / 编译型二进制</option>
                  </Select>
                </div>
              )
            )}
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-zinc-600">
              勾选需要自动开通的独立数据库（自动生成库名、账号密码与 secrets/db.env）：
            </span>
            <div className="flex flex-wrap gap-1.5">
              {(['postgresql', 'mysql', 'mongodb', 'redis'] as const).map((dbType) => {
                const active = selectedDbs.includes(dbType);
                return (
                  <button
                    key={dbType}
                    type="button"
                    onClick={() => toggleDb(dbType)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-zinc-900 text-white shadow-2xs'
                        : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100'
                    }`}
                  >
                    {active ? '✓ ' : '+ '}
                    {dbType.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3 pt-1">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-600">
                  发给 Claude Code / Codex / Cursor 的自然语言提示词：
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => copyText('ai-prompt', aiPromptPreview)}
                >
                  {copiedKey === 'ai-prompt' ? '✓ 已复制提示词' : '复制 AI 提示词'}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
                {aiPromptPreview}
              </pre>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-600">
                  对应生成的 publish.json 契约预览：
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => copyText('manifest', manifestPreview)}
                >
                  {copiedKey === 'manifest' ? '✓ 已复制 JSON' : '复制 publish.json'}
                </Button>
              </div>
              <pre className="max-h-48 overflow-y-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
                {manifestPreview}
              </pre>
            </div>
          </div>
        </Card>
      </div>

      {/* Shared Databases */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-zinc-700" />
          <h3 className="text-sm font-semibold text-zinc-900">
            服务器共享数据库底座（本机 127.0.0.1 隔离监听）
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {databases.map((db) => (
            <Card key={db.type} className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">
                    {db.type}
                  </span>
                  <h4 className="mt-0.5 text-sm font-semibold text-zinc-900">{db.name}</h4>
                </div>
                <Badge
                  variant={db.status === 'online' ? 'success' : 'secondary'}
                  className="font-mono text-[11px]"
                >
                  127.0.0.1:{db.port}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-zinc-500">{db.summary}</p>
              <div className="mt-3 border-t border-zinc-100 pt-2 font-mono text-[11px] text-zinc-500">
                🐳 容器: {db.container}
              </div>
            </Card>
          ))}
        </div>

        {provisionedProjects.length > 0 && (
          <Card className="p-4">
            <span className="mb-2 block text-xs font-medium text-zinc-600">
              已开通专属数据库的项目 ({provisionedProjects.length})：
            </span>
            <div className="flex flex-wrap gap-1.5">
              {provisionedProjects.map((item) => {
                const name = typeof item === 'string' ? item : item.project;
                const types = typeof item === 'string' ? '' : ` [${item.types.join(', ')}]`;
                return (
                  <Badge key={name} variant="outline" className="font-mono text-xs">
                    🗄️ {name}{types}
                  </Badge>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </section>
  );
};
