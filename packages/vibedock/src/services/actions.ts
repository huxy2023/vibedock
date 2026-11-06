import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActionDefinition, ActionMetadata, CatalogData } from '../types.js';
import type { CatalogService } from './catalog.js';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 24_000;

export function compactOutput(value: unknown, limit = OUTPUT_LIMIT): string {
  const text = String(value || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…输出已截断（共 ${text.length} 字符）`;
}

function publicAction(action: ActionDefinition): ActionMetadata {
  const { executor: _executor, ...metadata } = action;
  return metadata;
}

export function buildActionRegistry(
  catalog: CatalogData,
  options: { deployUser?: string; caddyConfig?: string } = {},
): Map<string, ActionDefinition> {
  const actions = new Map<string, ActionDefinition>();
  const deployUser = options.deployUser || 'vibe-deploy';
  const caddyConfig = options.caddyConfig || '/etc/caddy/Caddyfile';

  function add(action: ActionDefinition) {
    if (actions.has(action.id)) throw new Error(`Duplicate action id: ${action.id}`);
    actions.set(action.id, action);
  }

  for (const project of catalog.projects) {
    add({
      id: `${project.id}:diagnose`,
      projectId: project.id,
      label: '综合诊断',
      description: '核对组件监听器和对外入口，不执行系统命令',
      command: 'catalog diagnose',
      kind: 'diagnose',
      risk: 'read',
      executor: { type: 'diagnose', projectId: project.id },
    });

    for (const component of project.components) {
      const base = `${project.id}:${component.id}`;
      if (component.processManager === 'PM2' && component.processName) {
        add({
          id: `${base}:status`,
          projectId: project.id,
          componentId: component.id,
          label: `${component.name}状态`,
          description: '查看 PM2 进程状态、PID、重启次数和资源占用',
          command: `pm2 describe ${component.processName}`,
          kind: 'status',
          risk: 'read',
          executor: { type: 'exec', binary: 'pm2', args: ['describe', component.processName] },
        });
        add({
          id: `${base}:logs`,
          projectId: project.id,
          componentId: component.id,
          label: `${component.name}最近日志`,
          description: '读取最近 80 行，不持续跟随',
          command: `pm2 logs ${component.processName} --lines 80 --nostream`,
          kind: 'logs',
          risk: 'sensitive',
          executor: { type: 'exec', binary: 'pm2', args: ['logs', component.processName, '--lines', '80', '--nostream'] },
        });
        if (component.processName !== 'vibedock-portal') {
          add({
            id: `${base}:restart`,
            projectId: project.id,
            componentId: component.id,
            label: `重启${component.name}`,
            description: '通过 PM2 重启进程；需要原因和二次确认',
            command: `pm2 restart ${component.processName}`,
            kind: 'restart',
            risk: 'change',
            requiresReason: true,
            executor: { type: 'exec', binary: 'pm2', args: ['restart', component.processName] },
          });
        }
      } else if (String(component.processManager || '').startsWith('PM2 (') && (component.deploymentProcess || component.processName)) {
        const procName = (component.deploymentProcess || component.processName)!;
        if (/^[a-z0-9][a-z0-9_-]*$/.test(procName)) {
          add({
            id: `${base}:status`,
            projectId: project.id,
            componentId: component.id,
            label: `${component.name}状态`,
            description: '查看团队部署 PM2 进程状态、PID、重启次数和资源占用',
            command: `pm2 (${deployUser}) describe ${procName}`,
            kind: 'status',
            risk: 'read',
            executor: { type: 'exec', binary: 'deployPm2', args: ['describe', procName] },
          });
          add({
            id: `${base}:logs`,
            projectId: project.id,
            componentId: component.id,
            label: `${component.name}最近日志`,
            description: '读取团队应用最近 80 行日志，不持续跟随',
            command: `pm2 (${deployUser}) logs ${procName} --lines 80 --nostream`,
            kind: 'logs',
            risk: 'sensitive',
            executor: { type: 'exec', binary: 'deployPm2', args: ['logs', procName, '--lines', '80', '--nostream'] },
          });
          add({
            id: `${base}:restart`,
            projectId: project.id,
            componentId: component.id,
            label: `重启${component.name}`,
            description: '重启团队应用 PM2 进程；需要原因和二次确认',
            command: `pm2 (${deployUser}) restart ${procName}`,
            kind: 'restart',
            risk: 'change',
            requiresReason: true,
            executor: { type: 'exec', binary: 'deployPm2', args: ['restart', procName] },
          });
        }
      } else if (component.processName) {
        add({
          id: `${base}:status`,
          projectId: project.id,
          componentId: component.id,
          label: `${component.name}状态`,
          description: '查看 systemd 单元状态',
          command: `systemctl status ${component.processName} --no-pager --lines=30`,
          kind: 'status',
          risk: 'read',
          executor: { type: 'exec', binary: 'systemctl', args: ['status', component.processName, '--no-pager', '--lines=30'], allowNonZero: true },
        });
        add({
          id: `${base}:logs`,
          projectId: project.id,
          componentId: component.id,
          label: `${component.name}最近日志`,
          description: '读取 systemd 最近 80 行日志',
          command: `journalctl -u ${component.processName} -n 80 --no-pager`,
          kind: 'logs',
          risk: 'sensitive',
          executor: { type: 'exec', binary: 'journalctl', args: ['-u', component.processName, '-n', '80', '--no-pager'] },
        });
      }
    }
  }

  add({
    id: 'gateway:validate',
    label: '验证 Caddy 配置',
    description: '只验证当前配置，不重载网关',
    command: `caddy validate --config ${caddyConfig} --adapter caddyfile`,
    kind: 'health',
    risk: 'read',
    executor: {
      type: 'exec',
      binary: 'caddy',
      args: ['validate', '--config', caddyConfig, '--adapter', 'caddyfile'],
    },
  });

  return actions;
}

export interface OperationsServiceOptions {
  auditFile?: string;
  nodeBin?: string;
  pm2Bin?: string;
  sudoBin?: string;
  systemctlBin?: string;
  journalctlBin?: string;
  caddyBin?: string;
  caddyConfig?: string;
  deployUser?: string;
  pm2Home?: string;
}

export function createOperationsService(
  initialCatalog: CatalogData,
  catalogService: CatalogService,
  options: OperationsServiceOptions = {},
) {
  const deployUser = options.deployUser || 'vibe-deploy';
  const pm2Home = options.pm2Home || '/var/lib/vibedock/deploy/.pm2';
  const auditFile = options.auditFile;
  const binaryPaths = {
    pm2: options.pm2Bin || 'pm2',
    deployPm2: options.sudoBin || '/usr/bin/sudo',
    systemctl: options.systemctlBin || '/usr/bin/systemctl',
    journalctl: options.journalctlBin || '/usr/bin/journalctl',
    caddy: options.caddyBin || 'caddy',
  };
  const nodeBinDirectory = path.dirname(options.nodeBin || process.execPath);
  const running = new Set<string>();

  function getRegistry(): Map<string, ActionDefinition> {
    const latestCatalog = typeof catalogService?.current === 'function' ? catalogService.current() : initialCatalog;
    return buildActionRegistry(latestCatalog, {
      deployUser,
      caddyConfig: options.caddyConfig,
    });
  }

  async function audit(entry: Record<string, unknown>) {
    if (!auditFile) return;
    await fs.promises.mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
    await fs.promises.appendFile(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async function diagnose(projectId: string): Promise<string> {
    const snapshot = await catalogService.snapshot();
    const project = snapshot.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('Project is no longer in the catalog');
    const lines = [`${project.name}：${project.status === 'online' ? '所有组件当前在线' : '存在异常组件'}`];
    for (const component of project.components) {
      if (component.type === 'static') {
        lines.push(`- ${component.name}: ${component.online ? '静态入口可用' : '静态入口缺少 index.html'}`);
      } else {
        for (const listener of component.listeners) {
          lines.push(`- ${component.name} / ${listener.name || listener.id}: ${listener.host}:${listener.port} ${listener.online ? '可连接' : '不可连接'}`);
        }
      }
    }
    for (const rule of project.ingressRules) {
      lines.push(`- 入口 ${rule.match.hosts.join(', ')} ${rule.match.paths.join(', ')} (${rule.match.protocol}) → ${rule.target.component}.${rule.target.listener || 'static'}`);
    }
    return lines.join('\n');
  }

  async function runExecutor(executor: ActionDefinition['executor'], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw signal.reason || new DOMException('已停止', 'AbortError');
    if (executor.type === 'diagnose') return diagnose(executor.projectId);
    const binary = binaryPaths[executor.binary];
    if (!binary) throw new Error('Unsupported executor binary');
    const args =
      executor.binary === 'deployPm2'
        ? ['-n', '-u', deployUser, '/usr/bin/env', 'PATH=/usr/local/bin:/usr/bin:/bin', `PM2_HOME=${pm2Home}`, 'pm2', ...executor.args]
        : executor.args;
    const env = { ...process.env, PATH: `${nodeBinDirectory}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` };
    try {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        env,
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        signal,
      });
      return compactOutput([stdout, stderr].filter(Boolean).join('\n')) || '命令执行成功，无输出。';
    } catch (error: any) {
      const output = compactOutput([error.stdout, error.stderr].filter(Boolean).join('\n'));
      if (executor.allowNonZero && output) return output;
      const failure: any = new Error(output || error.message || '命令执行失败');
      failure.code = error.killed ? 'TIMEOUT' : 'COMMAND_FAILED';
      throw failure;
    }
  }

  async function execute(
    actionId: string,
    context: { confirmed?: boolean; reason?: string; actor?: string; source?: string; signal?: AbortSignal } = {},
  ) {
    const registry = getRegistry();
    const action = registry.get(actionId);
    if (!action) {
      throw Object.assign(new Error('未知或已失效的动作'), { status: 404 });
    }
    if (action.risk === 'change' && context.confirmed !== true) {
      throw Object.assign(new Error('变更动作需要二次确认'), { status: 409 });
    }
    const reason = String(context.reason || '').trim().slice(0, 200);
    if (action.requiresReason && reason.length < 2) {
      throw Object.assign(new Error('请填写本次操作原因'), { status: 400 });
    }
    if (running.has(actionId)) {
      throw Object.assign(new Error('该动作正在执行，请稍后再试'), { status: 409 });
    }

    const startedAt = new Date().toISOString();
    const auditBase = {
      id: crypto.randomUUID(),
      actionId,
      action: action.label,
      risk: action.risk,
      reason: reason || undefined,
      actor: context.actor || 'unknown',
      source: context.source || undefined,
      startedAt,
    };
    running.add(actionId);
    try {
      const output = await runExecutor(action.executor, context.signal);
      const completedAt = new Date().toISOString();
      await audit({ ...auditBase, status: 'succeeded', completedAt });
      return { action: publicAction(action), output, startedAt, completedAt, status: 'succeeded' as const };
    } catch (error: any) {
      await audit({ ...auditBase, status: 'failed', completedAt: new Date().toISOString(), error: compactOutput(error.message, 1000) });
      throw error;
    } finally {
      running.delete(actionId);
    }
  }

  return {
    execute,
    list(): ActionMetadata[] {
      return [...getRegistry().values()].map(publicAction);
    },
  };
}

export type OperationsService = ReturnType<typeof createOperationsService>;
