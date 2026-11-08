#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ServerAccessConfig {
  brandName?: string;
  serverHost: string;
  sshPort?: number;
  deployUser: string;
  domainSuffix?: string;
  appPrefix?: string;
  appsDir?: string;
  portalUrl?: string;
  publishCommand?: string;
  dbCommand?: string;
  remoteEnv?: string;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const SERVER_CFG_FILE = path.join(ROOT_DIR, 'access', 'server.json');

function shellQuote(arg: string): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function loadServerConfig(): ServerAccessConfig {
  if (!fs.existsSync(SERVER_CFG_FILE)) {
    throw new Error(`Missing access/server.json in skill package (${SERVER_CFG_FILE})`);
  }
  return JSON.parse(fs.readFileSync(SERVER_CFG_FILE, 'utf8')) as ServerAccessConfig;
}

function buildLogsRemoteCmd(cfg: ServerAccessConfig, projectId: string, lines: number): string {
  const prefix = cfg.appPrefix || 'team-';
  let raw = projectId.trim().toLowerCase();
  if (prefix && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length);
  }
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(raw)) {
    throw new Error('Invalid project ID format');
  }
  const ident = `${prefix}${raw}`;
  const clampedLines = Math.max(10, Math.min(lines, 500));
  const nodeScript = `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const rawId = ${JSON.stringify(raw)};
const ident = ${JSON.stringify(ident)};
const lines = ${clampedLines};
const proc = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
const items = JSON.parse(proc.stdout || '[]');
const matched = items.filter((p) => p.name === ident || String(p.name || '').startsWith(ident + '-') || p.name === rawId);
function tailFile(filePath, n) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\\r?\\n/).slice(-n).join('\\n');
  } catch {
    return '';
  }
}
const processes = matched.map((p) => {
  const env = p.pm2_env || {};
  const monit = p.monit || {};
  return {
    name: p.name,
    pm_id: p.pm_id,
    status: env.status,
    restarts: env.restart_time,
    uptime_ms: env.pm_uptime,
    memory: monit.memory,
    cpu: monit.cpu,
    stdout: tailFile(env.pm_out_log_path, lines),
    stderr: tailFile(env.pm_err_log_path, lines),
  };
});
console.log(JSON.stringify({ ok: true, project: ident, processes }, null, 2));
`.trim();
  return `node -e ${shellQuote(nodeScript)}`;
}

function main(): number {
  const cfg = loadServerConfig();
  const [op, ...rest] = process.argv.slice(2);
  if (!op) {
    console.error('Usage: node scripts/client.mjs <check|alloc|logs|exec|upload|publish|adopt|unpublish|db> [args...]');
    return 1;
  }

  const keyFile = path.join(ROOT_DIR, 'access', 'deploy_key');
  const knownHostsFile = path.join(ROOT_DIR, 'access', 'known_hosts');
  if (fs.existsSync(keyFile)) {
    fs.chmodSync(keyFile, 0o600);
  }
  const target = `${cfg.deployUser}@${cfg.serverHost}`;
  const sshPort = String(cfg.sshPort || 22);
  const sshOpts = [
    '-F',
    '/dev/null',
    '-i',
    keyFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
  ];
  if (fs.existsSync(knownHostsFile) && fs.statSync(knownHostsFile).size > 0) {
    sshOpts.push('-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsFile}`);
  } else {
    sshOpts.push('-o', 'StrictHostKeyChecking=accept-new');
  }

  if (op === 'upload') {
    const [localPath, remotePath] = rest;
    if (!localPath || !remotePath) {
      throw new Error('Usage: node scripts/client.mjs upload <local> <remote>');
    }
    const isDir = fs.statSync(localPath).isDirectory();
    const remoteDirToCreate = isDir ? remotePath : path.posix.dirname(remotePath);
    spawnSync('ssh', ['-p', sshPort, ...sshOpts, '-T', target, `mkdir -p ${shellQuote(remoteDirToCreate)}`], {
      stdio: 'inherit',
    });
    const sourceArg = isDir ? `${path.resolve(localPath)}/.` : localPath;
    const res = spawnSync('scp', ['-P', sshPort, ...sshOpts, '-r', sourceArg, `${target}:${remotePath}`], {
      stdio: 'inherit',
    });
    return res.status ?? 1;
  }

  const publishCmd = cfg.publishCommand || 'sudo -n /usr/local/bin/vibedock-publish';
  const dbCmd = cfg.dbCommand || 'sudo -n /usr/local/bin/vibedock-db-provision';
  const portalUrl = cfg.portalUrl || 'http://127.0.0.1:39090';
  const remoteEnv = cfg.remoteEnv || 'export PATH=/usr/local/bin:/usr/bin:/bin:$PATH; ';

  let remoteCommand = '';
  let stdinPayload: Buffer | undefined;

  switch (op) {
    case 'check':
      remoteCommand = `id; node --version; pm2 list; curl --max-time 10 -fsS http://127.0.0.1:39090/api/health`;
      break;
    case 'alloc':
    case 'allocate':
      remoteCommand = publishCmd;
      stdinPayload = Buffer.from(JSON.stringify({ action: 'alloc', id: rest[0] || '' }), 'utf8');
      break;
    case 'logs': {
      const projectId = rest[0];
      if (!projectId) throw new Error('Usage: node scripts/client.mjs logs <project-id> [--lines 60]');
      const linesIdx = rest.indexOf('--lines');
      const lines = linesIdx >= 0 && rest[linesIdx + 1] ? Number.parseInt(rest[linesIdx + 1], 10) : 60;
      remoteCommand = buildLogsRemoteCmd(cfg, projectId, Number.isFinite(lines) ? lines : 60);
      break;
    }
    case 'publish': {
      const manifestPath = rest[0];
      if (!manifestPath) throw new Error('Usage: node scripts/client.mjs publish <manifest.json>');
      remoteCommand = publishCmd;
      stdinPayload = fs.readFileSync(manifestPath);
      break;
    }
    case 'adopt': {
      const id = rest[0];
      const upIdx = rest.indexOf('--upstream');
      const upstream = upIdx >= 0 && rest[upIdx + 1] ? rest[upIdx + 1] : rest[1];
      if (!id || !upstream || upstream.startsWith('--')) {
        throw new Error('Usage: node scripts/client.mjs adopt <project-id> --upstream <http://host:port> [--name <name>]');
      }
      const nameIdx = rest.indexOf('--name');
      const descIdx = rest.indexOf('--description');
      const ownerIdx = rest.indexOf('--owner');
      const pathIdx = rest.indexOf('--path');
      remoteCommand = publishCmd;
      stdinPayload = Buffer.from(
        JSON.stringify({
          id,
          name: nameIdx >= 0 && rest[nameIdx + 1] ? rest[nameIdx + 1] : id,
          owner: ownerIdx >= 0 && rest[ownerIdx + 1] ? rest[ownerIdx + 1] : 'Infra',
          description:
            descIdx >= 0 && rest[descIdx + 1] ? rest[descIdx + 1] : `Adopted existing service (${upstream})`,
          tags: ['存量纳管'],
          components: [
            {
              id: 'upstream',
              kind: 'external',
              upstream,
            },
          ],
          routes: [
            {
              component: 'upstream',
              path: pathIdx >= 0 && rest[pathIdx + 1] ? rest[pathIdx + 1] : '/*',
            },
          ],
        }),
        'utf8',
      );
      break;
    }
    case 'unpublish': {
      const projectId = rest[0];
      if (!projectId) throw new Error('Usage: node scripts/client.mjs unpublish <project-id>');
      remoteCommand = publishCmd;
      stdinPayload = Buffer.from(JSON.stringify({ action: 'unpublish', id: projectId }), 'utf8');
      break;
    }
    case 'db': {
      if (!rest.length) throw new Error('Usage: node scripts/client.mjs db <status|provision|bind|get> [args...]');
      remoteCommand = `${dbCmd} ${rest.map(shellQuote).join(' ')}`;
      break;
    }
    case 'exec': {
      const cmd = rest.join(' ').trim();
      if (!cmd) throw new Error('Usage: node scripts/client.mjs exec "<command>"');
      remoteCommand = cmd;
      break;
    }
    default:
      throw new Error(`Unsupported command: ${op}`);
  }

  const res = spawnSync('ssh', ['-p', sshPort, ...sshOpts, '-T', target, remoteEnv + remoteCommand], {
    input: stdinPayload,
    stdio: [stdinPayload ? 'pipe' : 'inherit', 'inherit', 'inherit'],
  });
  return res.status ?? 1;
}

try {
  process.exit(main());
} catch (error: any) {
  console.error(error?.message || String(error));
  process.exit(1);
}
