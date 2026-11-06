import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function urllibQuote(value: string): string {
  return encodeURIComponent(value);
}

const activeLocks = new Set<string>();
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

export function withFileLock<T>(
  lockFile: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const resolvedLock = path.resolve(lockFile);
  if (activeLocks.has(resolvedLock)) {
    throw new Error(`Lock is already held: ${lockFile}`);
  }
  const timeoutMs = options.timeoutMs ?? 10000;
  const staleMs = options.staleMs ?? 30000;
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(resolvedLock), { recursive: true });
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(resolvedLock, 'wx', 0o600);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      try {
        const stat = fs.statSync(resolvedLock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(resolvedLock, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock: ${lockFile}`);
      }
      sleepSync(20);
    }
  }

  activeLocks.add(resolvedLock);
  try {
    return fn();
  } finally {
    activeLocks.delete(resolvedLock);
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.rmSync(resolvedLock, { force: true });
    } catch {}
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(targetPath: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode });
  fs.renameSync(tmpPath, targetPath);
}

export function isPortListeningByDeployUser(port: number, deployUser: string): { ok: boolean; error?: string } {
  const ssCheck = spawnSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 3000 });
  if (ssCheck.status === 0 && ssCheck.stdout) {
    if (!ssCheck.stdout.includes(`127.0.0.1:${port}`)) {
      return { ok: false, error: `Port 127.0.0.1:${port} is not listening (start your service with PM2 first)` };
    }
    return { ok: true };
  }
  const lsofCheck = spawnSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-P', '-n'], { encoding: 'utf8', timeout: 3000 });
  if (lsofCheck.status === 0 && lsofCheck.stdout.includes(`:${port}`)) {
    if (deployUser && lsofCheck.stdout.includes(deployUser)) return { ok: true };
    return { ok: true };
  }
  return { ok: false, error: `Port 127.0.0.1:${port} is not listening` };
}
