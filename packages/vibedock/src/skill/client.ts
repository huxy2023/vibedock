#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
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
  mcpUrl?: string;
  deployToken?: string;
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

export function buildLogsRemoteCmd(cfg: ServerAccessConfig, projectId: string, lines: number): string {
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

function normalizeProjectSlug(cfg: ServerAccessConfig, projectId: string): string {
  const prefix = cfg.appPrefix || 'team-';
  let raw = String(projectId || '').trim().toLowerCase();
  if (prefix && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(raw)) {
    throw new Error('Invalid project ID format');
  }
  return raw;
}

export function buildActivateRemoteCmd(cfg: ServerAccessConfig, projectId: string, release: string): string {
  const raw = normalizeProjectSlug(cfg, projectId);
  const rel = String(release || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(rel)) {
    throw new Error('Invalid release identifier');
  }
  const appsDir = cfg.appsDir || '/var/lib/vibedock/apps';
  const nodeScript = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const appRoot = path.join(${JSON.stringify(appsDir)}, ${JSON.stringify(raw)});
const releaseDir = path.join(appRoot, 'releases', ${JSON.stringify(rel)});
if (!fs.existsSync(releaseDir)) {
  throw new Error('Release directory does not exist: ' + releaseDir);
}
const currentLink = path.join(appRoot, 'current');
execFileSync('ln', ['-sfn', releaseDir, currentLink]);
console.log(JSON.stringify({ ok: true, project: ${JSON.stringify(raw)}, release: ${JSON.stringify(rel)}, currentPath: currentLink }, null, 2));
`.trim();
  return `node -e ${shellQuote(nodeScript)}`;
}

export interface StartServiceOptions {
  projectId: string;
  release: string;
  entry: string;
  port: number;
  component?: string;
  runtime?: 'node' | 'python' | 'go';
}

export function buildStartServiceRemoteCmd(cfg: ServerAccessConfig, opts: StartServiceOptions): string {
  const raw = normalizeProjectSlug(cfg, opts.projectId);
  const prefix = cfg.appPrefix || 'team-';
  const rel = String(opts.release || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(rel)) {
    throw new Error('Invalid release identifier');
  }
  const comp = String(opts.component || 'api').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(comp)) {
    throw new Error('Invalid component identifier');
  }
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Port must be an integer between 1024 and 65535');
  }
  const entry = String(opts.entry || '').trim();
  if (!entry || /[\r\n]/.test(entry)) {
    throw new Error('Entry point is required');
  }
  const runtime = (opts.runtime || 'node').toLowerCase();
  if (!['node', 'python', 'go'].includes(runtime)) {
    throw new Error('Unsupported runtime (expected node, python, or go)');
  }
  const appsDir = cfg.appsDir || '/var/lib/vibedock/apps';
  const procName = `${prefix}${raw}-${comp}`;

  const nodeScript = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const appRoot = path.join(${JSON.stringify(appsDir)}, ${JSON.stringify(raw)});
const releaseDir = path.join(appRoot, 'releases', ${JSON.stringify(rel)});
if (!fs.existsSync(releaseDir)) {
  throw new Error('Release directory does not exist: ' + releaseDir);
}
const currentLink = path.join(appRoot, 'current');
execFileSync('ln', ['-sfn', releaseDir, currentLink]);
const compDir = path.join(currentLink, ${JSON.stringify(comp)});
const workDir = fs.existsSync(compDir) ? compDir : currentLink;
const dbEnvFile = path.join(appRoot, 'secrets', 'db.env');
const extraEnv = {};
if (fs.existsSync(dbEnvFile)) {
  for (const line of fs.readFileSync(dbEnvFile, 'utf8').split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    }
    extraEnv[k] = v;
  }
}
const env = { ...process.env, ...extraEnv, HOST: '127.0.0.1', PORT: String(${port}), NODE_ENV: 'production' };
const runtime = ${JSON.stringify(runtime)};
const entry = ${JSON.stringify(entry)};
const procName = ${JSON.stringify(procName)};
if (runtime === 'node' && fs.existsSync(path.join(workDir, 'package.json'))) {
  const ci = spawnSync('npm', ['ci', '--omit=dev'], { cwd: workDir, env, encoding: 'utf8' });
  if (ci.status !== 0) {
    execFileSync('npm', ['install', '--omit=dev'], { cwd: workDir, env, stdio: 'pipe' });
  }
} else if (runtime === 'python' && fs.existsSync(path.join(workDir, 'pyproject.toml'))) {
  execFileSync('uv', ['sync'], { cwd: workDir, env, stdio: 'pipe' });
} else if (runtime === 'go') {
  const binPath = path.resolve(workDir, entry);
  if (fs.existsSync(binPath)) fs.chmodSync(binPath, 0o755);
}
spawnSync('pm2', ['delete', procName], { cwd: workDir, env, stdio: 'ignore' });
let pm2Args;
if (runtime === 'python') {
  pm2Args = entry.includes(':')
    ? ['start', '.venv/bin/uvicorn', '--name', procName, '--cwd', workDir, '--interpreter', 'none', '--', entry, '--host', '127.0.0.1', '--port', String(${port})]
    : ['start', '.venv/bin/python', '--name', procName, '--cwd', workDir, '--interpreter', 'none', '--', entry];
} else if (runtime === 'go') {
  pm2Args = ['start', entry, '--name', procName, '--cwd', workDir, '--interpreter', 'none'];
} else {
  pm2Args = ['start', entry, '--name', procName, '--cwd', workDir];
}
execFileSync('pm2', pm2Args, { cwd: workDir, env, stdio: 'pipe' });
spawnSync('pm2', ['save'], { cwd: workDir, env, stdio: 'ignore' });
console.log(JSON.stringify({ ok: true, project: ${JSON.stringify(raw)}, processName: procName, release: ${JSON.stringify(rel)}, port: ${port}, runtime, workDir }, null, 2));
`.trim();
  return `node -e ${shellQuote(nodeScript)}`;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : undefined;
}

function getMcpEndpoint(cfg: ServerAccessConfig): string {
  if (cfg.mcpUrl) return cfg.mcpUrl;
  const base = (cfg.portalUrl || `http://${cfg.serverHost}:39090`).replace(/\/+$/, '');
  return `${base}/api/mcp`;
}

export async function callServerMcpTool(
  cfg: ServerAccessConfig,
  toolName: string,
  toolArgs: Record<string, any> = {},
): Promise<any> {
  const token = cfg.deployToken || process.env.VIBEDOCK_DEPLOY_TOKEN || '';
  if (!token) {
    throw new Error('Missing deployToken in access/server.json for HTTP/MCP backup path');
  }
  const resp = await fetch(getMcpEndpoint(cfg), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`HTTP MCP error (${resp.status}): ${errText || resp.statusText}`);
  }
  const payload = (await resp.json()) as Record<string, any>;
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }
  const result = payload.result || {};
  if (result.isError) {
    const msg = result.content?.[0]?.text || 'MCP tool call failed';
    throw new Error(msg);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function uploadViaHttp(cfg: ServerAccessConfig, localPath: string, remotePath: string): Promise<number> {
  const token = cfg.deployToken || process.env.VIBEDOCK_DEPLOY_TOKEN || '';
  if (!token) {
    throw new Error('Missing deployToken in access/server.json for HTTP upload fallback');
  }
  const appsDir = (cfg.appsDir || '/var/lib/vibedock/apps').replace(/\/+$/, '');
  const relFromApps = remotePath.startsWith(`${appsDir}/`) ? remotePath.slice(appsDir.length + 1) : remotePath;
  const parts = relFromApps.split('/').filter(Boolean);
  // Expected: <project>/releases/<release>[/<subpath...>]
  if (parts.length < 3 || parts[1] !== 'releases') {
    throw new Error(`HTTP upload fallback expects remote path under ${appsDir}/<project>/releases/<release>`);
  }
  const [project, , release, ...subParts] = parts;
  const subpath = subParts.join('/');

  const tmpTar = path.join(os.tmpdir(), `vibedock-client-upload-${process.pid}-${Date.now()}.tar.gz`);
  try {
    const absLocal = path.resolve(localPath);
    const st = fs.statSync(absLocal);
    const tarArgs = st.isDirectory()
      ? ['-czf', tmpTar, '-C', absLocal, '.']
      : ['-czf', tmpTar, '-C', path.dirname(absLocal), path.basename(absLocal)];
    const tarRes = spawnSync('tar', tarArgs, { encoding: 'utf8' });
    if (tarRes.status !== 0) {
      throw new Error(`Failed to pack local archive: ${(tarRes.stderr || tarRes.stdout || '').trim()}`);
    }
    const base = (cfg.portalUrl || `http://${cfg.serverHost}:39090`).replace(/\/+$/, '');
    const url = new URL(`${base}/api/dx/upload`);
    url.searchParams.set('project', project);
    url.searchParams.set('release', release);
    if (subpath) url.searchParams.set('subpath', subpath);

    const bodyBuf = fs.readFileSync(tmpTar);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${token}`,
      },
      body: bodyBuf,
    });
    const data = (await resp.json().catch(() => ({}))) as Record<string, any>;
    if (!resp.ok) {
      throw new Error(data.error || `HTTP upload failed (${resp.status})`);
    }
    console.log(JSON.stringify(data, null, 2));
    return 0;
  } finally {
    fs.rmSync(tmpTar, { force: true });
  }
}

async function runLocalMcpStdioServer(cfg: ServerAccessConfig): Promise<number> {
  const token = cfg.deployToken || process.env.VIBEDOCK_DEPLOY_TOKEN || '';
  const endpoint = getMcpEndpoint(cfg);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: any;
    try {
      req = JSON.parse(trimmed);
    } catch {
      continue;
    }
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(req),
      });
      const json = await resp.json();
      if (req.id !== undefined) {
        process.stdout.write(`${JSON.stringify(json)}\n`);
      }
    } catch (err: any) {
      if (req.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err?.message || String(err) } })}\n`,
        );
      }
    }
  }
  return 0;
}

async function executeViaHttpMcpFallback(
  cfg: ServerAccessConfig,
  op: string,
  rest: string[],
): Promise<number> {
  switch (op) {
    case 'check': {
      const out = await callServerMcpTool(cfg, 'vibedock_check', {});
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'alloc':
    case 'allocate': {
      const out = await callServerMcpTool(cfg, 'vibedock_alloc', { projectId: rest[0] || '' });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'logs': {
      const linesIdx = rest.indexOf('--lines');
      const lines = linesIdx >= 0 && rest[linesIdx + 1] ? Number.parseInt(rest[linesIdx + 1], 10) : 60;
      const out = await callServerMcpTool(cfg, 'vibedock_logs', { projectId: rest[0], lines });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'activate': {
      const release = getFlagValue(rest, '--release') || rest[1];
      const out = await callServerMcpTool(cfg, 'vibedock_activate', { projectId: rest[0], release });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'start-service': {
      const out = await callServerMcpTool(cfg, 'vibedock_start_service', {
        projectId: rest[0],
        release: getFlagValue(rest, '--release') || 'v1',
        entry: getFlagValue(rest, '--entry'),
        port: Number.parseInt(getFlagValue(rest, '--port') || '0', 10),
        component: getFlagValue(rest, '--component') || 'api',
        runtime: getFlagValue(rest, '--runtime') || 'node',
      });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'publish': {
      const manifest = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
      const out = await callServerMcpTool(cfg, 'vibedock_publish', { manifest });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'adopt': {
      const id = rest[0];
      const upIdx = rest.indexOf('--upstream');
      const upstream = upIdx >= 0 && rest[upIdx + 1] ? rest[upIdx + 1] : rest[1];
      const out = await callServerMcpTool(cfg, 'vibedock_adopt', {
        id,
        upstream,
        name: getFlagValue(rest, '--name') || id,
        owner: getFlagValue(rest, '--owner') || 'Infra',
        description: getFlagValue(rest, '--description'),
      });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'unpublish': {
      const out = await callServerMcpTool(cfg, 'vibedock_unpublish', { projectId: rest[0] });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'db': {
      const [sub, ...dbRest] = rest;
      if (sub === 'status') {
        const out = await callServerMcpTool(cfg, 'vibedock_db_status', {});
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }
      if (sub === 'provision') {
        const typesRaw = getFlagValue(dbRest, '--types') || 'all';
        const format = getFlagValue(dbRest, '--format') || 'json';
        const types = typesRaw === 'all' ? undefined : typesRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const out = await callServerMcpTool(cfg, 'vibedock_db_provision', {
          projectId: dbRest[0],
          types,
          writeEnvFile: true,
        });
        if (format === 'env' && out.env) {
          process.stdout.write(out.env);
        } else {
          console.log(JSON.stringify(out, null, 2));
        }
        return 0;
      }
      if (sub === 'bind') {
        const out = await callServerMcpTool(cfg, 'vibedock_db_bind', {
          projectId: dbRest[0],
          postgresql: getFlagValue(dbRest, '--postgresql') || getFlagValue(dbRest, '--postgres'),
          mysql: getFlagValue(dbRest, '--mysql'),
          mongodb: getFlagValue(dbRest, '--mongodb') || getFlagValue(dbRest, '--mongo'),
          redis: getFlagValue(dbRest, '--redis'),
          writeEnvFile: true,
        });
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }
      if (sub === 'get') {
        const format = getFlagValue(dbRest, '--format') || 'json';
        const out = await callServerMcpTool(cfg, 'vibedock_db_get', { projectId: dbRest[0], format });
        if (format === 'env' && out.env) {
          process.stdout.write(out.env);
        } else {
          console.log(JSON.stringify(out, null, 2));
        }
        return 0;
      }
      throw new Error(`Unsupported db subcommand for HTTP MCP fallback: ${sub}`);
    }
    default:
      throw new Error(`Operation "${op}" is not supported over HTTP MCP fallback`);
  }
}

async function main(): Promise<number> {
  const cfg = loadServerConfig();
  const rawArgs = process.argv.slice(2);
  const forceHttp = rawArgs.includes('--http') || process.env.VIBEDOCK_TRANSPORT === 'http';
  const [op, ...rest] = rawArgs.filter((a) => a !== '--http');
  if (!op) {
    console.error(
      'Usage: node scripts/client.mjs <check|alloc|logs|start-service|activate|exec|upload|publish|adopt|unpublish|db|mcp> [args...] [--http]',
    );
    return 1;
  }

  if (op === 'mcp') {
    return runLocalMcpStdioServer(cfg);
  }

  const keyFile = path.join(ROOT_DIR, 'access', 'deploy_key');
  const knownHostsFile = path.join(ROOT_DIR, 'access', 'known_hosts');
  if (fs.existsSync(keyFile)) {
    try {
      fs.chmodSync(keyFile, 0o600);
    } catch {
      // Ignore chmod error on Windows
    }
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
      throw new Error('Usage: node scripts/client.mjs upload <local> <remote> [--http]');
    }
    if (forceHttp) {
      return uploadViaHttp(cfg, localPath, remotePath);
    }
    const isDir = fs.statSync(localPath).isDirectory();
    const remoteDirToCreate = isDir ? remotePath : path.posix.dirname(remotePath);
    const mkdirRes = spawnSync('ssh', ['-p', sshPort, ...sshOpts, '-T', target, `mkdir -p ${shellQuote(remoteDirToCreate)}`], {
      stdio: 'inherit',
    });
    if (mkdirRes.status === 0) {
      const sourceArg = isDir ? `${path.resolve(localPath)}/.` : localPath;
      const res = spawnSync('scp', ['-P', sshPort, ...sshOpts, '-r', sourceArg, `${target}:${remotePath}`], {
        stdio: 'inherit',
      });
      if (res.status === 0) return 0;
    }
    if (cfg.deployToken || process.env.VIBEDOCK_DEPLOY_TOKEN) {
      console.error('[vibedock] Primary SSH upload failed; falling back to authenticated HTTP upload...');
      return uploadViaHttp(cfg, localPath, remotePath);
    }
    return 1;
  }

  if (forceHttp) {
    return executeViaHttpMcpFallback(cfg, op, rest);
  }

  const publishCmd = cfg.publishCommand || 'sudo -n /usr/local/bin/vibedock-publish';
  const dbCmd = cfg.dbCommand || 'sudo -n /usr/local/bin/vibedock-db-provision';
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
    case 'activate': {
      const projectId = rest[0];
      const release = getFlagValue(rest, '--release') || rest[1];
      if (!projectId || !release) {
        throw new Error('Usage: node scripts/client.mjs activate <project-id> --release <release-id>');
      }
      remoteCommand = buildActivateRemoteCmd(cfg, projectId, release);
      break;
    }
    case 'start-service': {
      const projectId = rest[0];
      const release = getFlagValue(rest, '--release') || 'v1';
      const entry = getFlagValue(rest, '--entry');
      const portStr = getFlagValue(rest, '--port');
      const component = getFlagValue(rest, '--component') || 'api';
      const runtime = (getFlagValue(rest, '--runtime') || 'node') as 'node' | 'python' | 'go';
      if (!projectId || !entry || !portStr) {
        throw new Error(
          'Usage: node scripts/client.mjs start-service <project-id> --release <v1> --entry <server.mjs> --port <40001> [--component api] [--runtime node|python|go]',
        );
      }
      remoteCommand = buildStartServiceRemoteCmd(cfg, {
        projectId,
        release,
        entry,
        port: Number.parseInt(portStr, 10),
        component,
        runtime,
      });
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
  if ((res.status === 255 || res.error) && op !== 'exec' && (cfg.deployToken || process.env.VIBEDOCK_DEPLOY_TOKEN)) {
    console.error('[vibedock] Primary SSH path unavailable; falling back to authenticated HTTP MCP path...');
    return executeViaHttpMcpFallback(cfg, op, rest);
  }
  return res.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: any) => {
      console.error(error?.message || String(error));
      process.exit(1);
    });
}
