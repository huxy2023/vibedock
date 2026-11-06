import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CatalogData, CatalogProject } from '../../types.js';
import type { CatalogService } from '../catalog.js';
import type { OperationsService } from '../actions.js';

const execFileAsync = promisify(execFile);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.astro', 'coverage', 'vendor']);
const SECRET_FILE = /(^|\/)(\.env(?:\.|$)|[^/]*(?:secret|credential|private[-_.]?key)[^/]*)/i;
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.java', '.js', '.json', '.jsx', '.md',
  '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.ts', '.tsx',
  '.txt', '.vue', '.xml', '.yaml', '.yml',
]);

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason || new DOMException('已停止', 'AbortError');
}

function compact(value: unknown, limit = 12_000): string {
  const text = String(value || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n…内容已截断`;
}

function publicProject(project: CatalogProject) {
  return { id: project.id, name: project.name, projectPath: project.projectPath };
}

export interface WorkspaceToolsOptions {
  catalog?: CatalogData;
  catalogService?: CatalogService;
  operationsService: OperationsService;
}

export function createWorkspaceTools(options: WorkspaceToolsOptions) {
  const { catalog, catalogService, operationsService } = options;

  function getProjectsMap(): Map<string, CatalogProject> {
    const latest = catalogService ? catalogService.current() : catalog!;
    return new Map(latest.projects.filter((project) => project.projectPath).map((project) => [project.id, project]));
  }

  function getProject(projectId: string, allowedProjectIds?: string[]): CatalogProject {
    const projects = getProjectsMap();
    const project = projects.get(String(projectId || ''));
    if (!project || (allowedProjectIds?.length && !allowedProjectIds.includes(project.id))) {
      throw Object.assign(new Error('项目不存在或不在本次上下文中'), { status: 400 });
    }
    return project;
  }

  function resolveProjectFile(project: CatalogProject, relativePath: string) {
    const relative = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
    if (!relative || relative.includes('\0') || SECRET_FILE.test(relative)) throw new Error('该文件不允许读取');
    const parts = relative.split('/');
    if (parts.some((part) => !part || part === '..' || SKIP_DIRECTORIES.has(part))) throw new Error('路径不允许读取');
    const root = path.resolve(project.projectPath!);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('路径超出项目目录');
    if (fs.existsSync(target)) {
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error('符号链接超出项目目录');
    }
    return { relative, target };
  }

  async function walk(project: CatalogProject, signal?: AbortSignal, maxFiles = 200): Promise<string[]> {
    const files: string[] = [];
    const pending = [''];
    while (pending.length && files.length < maxFiles) {
      abortIfNeeded(signal);
      const relativeDirectory = pending.shift()!;
      const directory = path.join(project.projectPath!, relativeDirectory);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (error: any) {
        if (error.code === 'ENOENT') throw new Error(`项目目录不存在：${project.projectPath}`);
        throw error;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relative = path.posix.join(relativeDirectory.replaceAll(path.sep, '/'), entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.cache')) pending.push(relative);
        } else if (entry.isFile() && !SECRET_FILE.test(relative)) {
          files.push(relative);
          if (files.length >= maxFiles) break;
        }
      }
    }
    return files;
  }

  function definitions(context: { projectIds?: string[]; permission?: string; role?: string } = {}) {
    const projectIds = [...getProjectsMap().keys()];
    const allowed = context.projectIds?.length ? projectIds.filter((id) => context.projectIds!.includes(id)) : projectIds;
    const projectProperty = { type: 'string', enum: allowed, description: '目录中登记的项目 ID' };
    const actions = operationsService.list().filter(
      (action) => !context.projectIds?.length || !action.projectId || context.projectIds.includes(action.projectId),
    );
    const actionIds = actions
      .filter((action) => action.risk !== 'change' || context.permission === 'change')
      .map((action) => action.id);

    return [
      {
        type: 'function',
        name: 'run_service_action',
        description: '运行服务目录中已登记的诊断、状态或日志动作。变更动作只生成待人工执行建议。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { actionId: { type: 'string', enum: actionIds } },
          required: ['actionId'],
        },
        strict: true,
      },
      {
        type: 'function',
        name: 'list_project_files',
        description: '列出项目文件（排除依赖、构建产物、Git 和敏感文件）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { projectId: projectProperty },
          required: ['projectId'],
        },
        strict: true,
      },
      {
        type: 'function',
        name: 'read_project_file',
        description: '读取项目内的文本文件，用于分析配置或源码。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: projectProperty,
            relativePath: { type: 'string', minLength: 1, maxLength: 500 },
          },
          required: ['projectId', 'relativePath'],
        },
        strict: true,
      },
      {
        type: 'function',
        name: 'search_project_code',
        description: '在项目文本文件内按字面量搜索代码或配置。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: projectProperty,
            query: { type: 'string', minLength: 2, maxLength: 120 },
          },
          required: ['projectId', 'query'],
        },
        strict: true,
      },
      {
        type: 'function',
        name: 'inspect_git',
        description: '查看项目 Git 状态、最近提交和变更统计，只读。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { projectId: projectProperty },
          required: ['projectId'],
        },
        strict: true,
      },
    ].filter((tool) => {
      if (tool.name === 'run_service_action') return Boolean(actionIds.length);
      if (context.role && context.role !== 'admin') return false;
      return true;
    });
  }

  function label(name: string, args: Record<string, any>): string {
    const project = getProjectsMap().get(args.projectId);
    if (name === 'run_service_action') {
      return operationsService.list().find((action) => action.id === args.actionId)?.label || String(args.actionId || name);
    }
    if (name === 'list_project_files') return `浏览 ${project?.name || args.projectId} 文件`;
    if (name === 'read_project_file') return `读取 ${project?.name || args.projectId} / ${args.relativePath}`;
    if (name === 'search_project_code') return `搜索 ${project?.name || args.projectId}：${args.query}`;
    if (name === 'inspect_git') return `查看 ${project?.name || args.projectId} Git 状态`;
    return name;
  }

  async function execute(
    name: string,
    args: Record<string, any>,
    context: { projectIds?: string[]; permission?: string; role?: string; actor?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, any>> {
    abortIfNeeded(context.signal);
    if (name === 'run_service_action') {
      const action = operationsService.list().find((item) => item.id === args.actionId);
      if (!action || (context.projectIds?.length && action.projectId && !context.projectIds.includes(action.projectId))) {
        throw new Error('动作不存在或不在本次上下文中');
      }
      if (action.risk === 'change') {
        if (context.permission !== 'change') throw new Error('当前是只读权限，不能生成变更动作');
        return {
          approvalRequired: true,
          actionId: action.id,
          label: action.label,
          command: action.command,
          reason: '模型建议变更；必须由用户点击并填写原因后执行。',
        };
      }
      const result = await operationsService.execute(action.id, {
        actor: context.actor,
        source: 'agent-tool',
        signal: context.signal,
      });
      return {
        actionId: action.id,
        label: action.label,
        command: action.command,
        status: result.status,
        output: compact(result.output, 8_000),
      };
    }

    if (context.role && context.role !== 'admin') {
      throw new Error('当前账号为普通成员权限，仅支持执行应用状态与日志诊断，不支持直接读取宿主机源码文件');
    }

    const project = getProject(args.projectId, context.projectIds);
    if (name === 'list_project_files') {
      return { project: publicProject(project), files: await walk(project, context.signal) };
    }
    if (name === 'read_project_file') {
      const file = resolveProjectFile(project, args.relativePath);
      const stat = await fs.promises.stat(file.target);
      if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('文件不存在、不是普通文件或超过 512KB');
      if (
        !TEXT_EXTENSIONS.has(path.extname(file.relative).toLowerCase()) &&
        !['Dockerfile', 'Caddyfile', 'Makefile'].includes(path.basename(file.relative))
      ) {
        throw new Error('仅允许读取已知文本文件');
      }
      const content = await fs.promises.readFile(file.target, 'utf8');
      if (content.includes('\0')) throw new Error('不支持二进制文件');
      return { project: publicProject(project), path: file.relative, content: compact(content) };
    }
    if (name === 'search_project_code') {
      const query = String(args.query || '').trim();
      if (query.length < 2) throw new Error('搜索内容至少 2 个字符');
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const relative of await walk(project, context.signal)) {
        abortIfNeeded(context.signal);
        if (
          !TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()) &&
          !['Dockerfile', 'Caddyfile', 'Makefile'].includes(path.basename(relative))
        ) {
          continue;
        }
        const target = resolveProjectFile(project, relative).target;
        const stat = await fs.promises.stat(target).catch(() => null);
        if (!stat || stat.size > 512 * 1024) continue;
        const content = await fs.promises.readFile(target, 'utf8').catch(() => '');
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (matches.length < 50 && line.toLowerCase().includes(query.toLowerCase())) {
            matches.push({ path: relative, line: index + 1, text: compact(line, 300) });
          }
        });
        if (matches.length >= 50) break;
      }
      return { project: publicProject(project), query, matches };
    }
    if (name === 'inspect_git') {
      const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
      const commands = [
        ['status', '--short', '--branch'],
        ['log', '-5', '--pretty=format:%h %ad %s', '--date=short'],
        ['diff', '--stat'],
      ];
      const outputs: string[] = [];
      for (const command of commands) {
        abortIfNeeded(context.signal);
        try {
          const { stdout, stderr } = await execFileAsync('/usr/bin/git', command, {
            cwd: project.projectPath,
            env,
            timeout: 5_000,
            maxBuffer: 128 * 1024,
            signal: context.signal,
          });
          outputs.push(`$ git ${command.join(' ')}\n${compact([stdout, stderr].filter(Boolean).join('\n'), 4_000) || '无输出'}`);
        } catch (error: any) {
          if (error.name === 'AbortError' || context.signal?.aborted) throw error;
          outputs.push(`$ git ${command.join(' ')}\n${compact(error.stderr || error.message, 1_000)}`);
        }
      }
      return { project: publicProject(project), output: outputs.join('\n\n') };
    }
    throw new Error(`不支持的工具：${name}`);
  }

  return { definitions, execute, label };
}

export type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
