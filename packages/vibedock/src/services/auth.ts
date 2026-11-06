import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UserDto, UserRole } from '../types.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const COOKIE_NAME = 'vibedock_session';

function nowIso(): string {
  return new Date().toISOString();
}

function httpError(message: string, status = 400): Error & { status: number; expose: boolean } {
  return Object.assign(new Error(message), { status, expose: true });
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): string {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, expectedHex] = String(storedHash || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeUsername(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(username: string): void {
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    throw httpError('账号名需为 2-32 位字母、数字、点、下划线或连字符', 400);
  }
}

function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.trim().length < 4 || password.length > 128) {
    throw httpError('密码长度需在 4 到 128 个字符之间', 400);
  }
}

export interface AuthServiceOptions {
  databaseFile: string;
  defaultAdminUser?: string;
  defaultAdminDisplayName?: string;
  defaultAdminPassword?: string;
  defaultMemberPassword?: string;
  defaultInviteCode?: string;
}

export function createAuthService(options: AuthServiceOptions) {
  const { databaseFile } = options;
  if (!databaseFile) throw new Error('AUTH_DB_FILE is required');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  if (databaseFile !== ':memory:' && !fs.existsSync(databaseFile)) {
    fs.writeFileSync(databaseFile, '', { mode: 0o600 });
  }
  const db = new DatabaseSync(databaseFile, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (databaseFile !== ':memory:') {
    for (const f of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);

  const defaultAdminUser = normalizeUsername(options.defaultAdminUser || process.env.DEFAULT_ADMIN_USER || 'admin');
  const defaultAdminDisplayName = options.defaultAdminDisplayName || process.env.DEFAULT_ADMIN_NAME || '系统管理员';
  const defaultAdminPassword = options.defaultAdminPassword || process.env.DEFAULT_ADMIN_PASSWORD || 'vibe2026';
  const defaultMemberPassword = options.defaultMemberPassword || process.env.DEFAULT_MEMBER_PASSWORD || 'vibe2026';
  const defaultInviteCode = options.defaultInviteCode ?? process.env.DEFAULT_INVITE_CODE ?? 'vibe2026';

  const countRow = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number } | undefined;
  if (!countRow || countRow.count === 0) {
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, display_name, role, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const now = nowIso();
    insertUser.run(crypto.randomUUID(), defaultAdminUser, defaultAdminDisplayName, 'admin', hashPassword(defaultAdminPassword), now);
    if (defaultAdminUser !== 'admin') {
      insertUser.run(crypto.randomUUID(), 'admin', '系统管理员', 'admin', hashPassword(defaultAdminPassword), now);
    }
    insertUser.run(crypto.randomUUID(), 'team', '团队成员', 'member', hashPassword(defaultMemberPassword), now);
  }

  const inviteRow = db.prepare("SELECT value FROM settings WHERE key = 'invite_code'").get();
  if (!inviteRow) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('invite_code', ?)").run(String(defaultInviteCode));
  }

  function toUserDto(row: Record<string, any> | undefined): UserDto | null {
    if (!row) return null;
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: row.role as UserRole,
      createdAt: String(row.created_at),
      lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    };
  }

  function issueSession(userId: string): string {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(rawToken), userId, createdAt, expiresAt);
    return rawToken;
  }

  function authenticate(rawToken: string): UserDto | null {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    const row = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.created_at, u.last_login_at, s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash) as Record<string, any> | undefined;
    if (!row) return null;
    if (String(row.expires_at) <= nowIso()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return toUserDto(row);
  }

  function login(usernameInput: unknown, passwordInput: unknown): { token: string; user: UserDto } {
    const username = normalizeUsername(usernameInput);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, any> | undefined;
    if (!row || !verifyPassword(String(passwordInput || ''), String(row.password_hash))) {
      throw httpError('账号或密码不正确', 401);
    }
    const now = nowIso();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
    row.last_login_at = now;
    const token = issueSession(String(row.id));
    return { token, user: toUserDto(row)! };
  }

  function getInviteCode(): string {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'invite_code'").get() as { value: string } | undefined;
    return row ? String(row.value) : '';
  }

  function updateInviteCode(newCode: unknown): { inviteCode: string } {
    const code = String(newCode ?? '').trim();
    db.prepare("INSERT INTO settings (key, value) VALUES ('invite_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(code);
    return { inviteCode: code };
  }

  function register(input: { username?: unknown; displayName?: unknown; password?: unknown; inviteCode?: unknown }): { token: string; user: UserDto } {
    const expectedInvite = getInviteCode();
    if (!expectedInvite) {
      throw httpError('当前已关闭自助注册，请联系管理员开通账号', 403);
    }
    if (String(input.inviteCode || '').trim() !== expectedInvite) {
      throw httpError('团队邀请码不正确', 403);
    }
    const username = normalizeUsername(input.username);
    validateUsername(username);
    validatePassword(input.password);
    const displayName = String(input.displayName || username).trim().slice(0, 32) || username;

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      throw httpError('该账号名已被注册，请直接登录或更换名称', 409);
    }

    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare(`
      INSERT INTO users (id, username, display_name, role, password_hash, created_at, last_login_at)
      VALUES (?, ?, ?, 'member', ?, ?, ?)
    `).run(id, username, displayName, hashPassword(input.password), now, now);

    const user = toUserDto(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, any>)!;
    const token = issueSession(id);
    return { token, user };
  }

  function logout(rawToken: string): void {
    if (!rawToken) return;
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
  }

  function changePassword(userId: string, currentPassword: unknown, newPassword: unknown): { updated: true; token: string } {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, any> | undefined;
    if (!row) throw httpError('用户不存在', 404);
    if (!verifyPassword(String(currentPassword || ''), String(row.password_hash))) {
      throw httpError('当前密码不正确', 400);
    }
    validatePassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    const token = issueSession(userId);
    return { updated: true, token };
  }

  function listUsers(): { users: UserDto[]; inviteCode: string } {
    const rows = db.prepare('SELECT * FROM users ORDER BY role ASC, created_at ASC').all() as Array<Record<string, any>>;
    return {
      users: rows.map((r) => toUserDto(r)!),
      inviteCode: getInviteCode(),
    };
  }

  function createUser(input: { username?: unknown; displayName?: unknown; password?: unknown; role?: unknown }): UserDto {
    const username = normalizeUsername(input.username);
    validateUsername(username);
    validatePassword(input.password);
    const validRole: UserRole = input.role === 'admin' ? 'admin' : 'member';
    const displayName = String(input.displayName || username).trim().slice(0, 32) || username;

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) throw httpError('账号名已存在', 409);

    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare(`
      INSERT INTO users (id, username, display_name, role, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, username, displayName, validRole, hashPassword(input.password), now);
    return toUserDto(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, any>)!;
  }

  function updateUser(userId: string, input: { displayName?: unknown; role?: unknown; password?: unknown }): UserDto {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, any> | undefined;
    if (!row) throw httpError('用户不存在', 404);

    if (input.role && input.role !== row.role && row.role === 'admin' && input.role !== 'admin') {
      const adminCount = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number }).count;
      if (adminCount <= 1) throw httpError('系统至少需要保留一位管理员', 400);
    }

    const nextName = input.displayName !== undefined ? String(input.displayName).trim().slice(0, 32) || String(row.display_name) : String(row.display_name);
    const nextRole = input.role === 'admin' || input.role === 'member' ? input.role : String(row.role);
    const nextHash = input.password ? (validatePassword(input.password), hashPassword(input.password)) : String(row.password_hash);

    db.prepare('UPDATE users SET display_name = ?, role = ?, password_hash = ? WHERE id = ?')
      .run(nextName, nextRole, nextHash, userId);
    if (input.password || (input.role && input.role !== row.role)) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    return toUserDto(db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, any>)!;
  }

  function deleteUser(userId: string, actorUserId?: string): { deleted: true } {
    if (userId === actorUserId) throw httpError('不能删除当前正在登录的管理员账号', 400);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, any> | undefined;
    if (!row) throw httpError('用户不存在', 404);
    if (row.role === 'admin') {
      const adminCount = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number }).count;
      if (adminCount <= 1) throw httpError('系统至少需要保留一位管理员', 400);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return { deleted: true };
  }

  function close(): void {
    db.close();
  }

  return {
    COOKIE_NAME,
    SESSION_TTL_MS,
    login,
    register,
    authenticate,
    logout,
    changePassword,
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    getInviteCode,
    updateInviteCode,
    close,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
