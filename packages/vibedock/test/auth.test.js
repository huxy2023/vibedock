import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthService } from '../dist/services/auth.js';

function createTempAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibedock-auth-test-'));
  const dbFile = path.join(dir, 'auth.sqlite3');
  const service = createAuthService({
    databaseFile: dbFile,
    defaultAdminPassword: 'admin-pass-123',
    defaultMemberPassword: 'member-pass-123',
    defaultInviteCode: 'invite-2026',
  });
  return {
    service,
    cleanup() {
      service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('authService seeds default admin and member accounts and authenticates sessions', () => {
  const { service, cleanup } = createTempAuth();
  try {
    const adminLogin = service.login('admin', 'admin-pass-123');
    assert.equal(adminLogin.user.username, 'admin');
    assert.equal(adminLogin.user.role, 'admin');
    assert.ok(adminLogin.token);

    const sessionUser = service.authenticate(adminLogin.token);
    assert.equal(sessionUser.username, 'admin');
    assert.equal(sessionUser.role, 'admin');

    service.logout(adminLogin.token);
    assert.equal(service.authenticate(adminLogin.token), null);
  } finally {
    cleanup();
  }
});

test('authService supports invite-code self-registration and admin user management', () => {
  const { service, cleanup } = createTempAuth();
  try {
    assert.throws(() => {
      service.register({
        username: 'zhangsan',
        displayName: '张三',
        password: 'pass1234',
        inviteCode: 'wrong-code',
      });
    }, /团队邀请码不正确/);

    const reg = service.register({
      username: 'zhangsan',
      displayName: '张三',
      password: 'pass1234',
      inviteCode: 'invite-2026',
    });
    assert.equal(reg.user.username, 'zhangsan');
    assert.equal(reg.user.displayName, '张三');
    assert.equal(reg.user.role, 'member');

    service.changePassword(reg.user.id, 'pass1234', 'newpass5678');
    const relogin = service.login('zhangsan', 'newpass5678');
    assert.equal(relogin.user.id, reg.user.id);

    const promoted = service.updateUser(reg.user.id, { role: 'admin' });
    assert.equal(promoted.role, 'admin');

    const all = service.listUsers();
    assert.ok(all.users.some((u) => u.username === 'zhangsan'));
  } finally {
    cleanup();
  }
});

test('authService invalidates existing sessions when password or role is updated', () => {
  const { service, cleanup } = createTempAuth();
  try {
    const loginRes = service.login('team', 'member-pass-123');
    assert.ok(service.authenticate(loginRes.token));

    service.updateUser(loginRes.user.id, { password: 'reset-pass-456' });
    assert.equal(service.authenticate(loginRes.token), null);

    const login2 = service.login('team', 'reset-pass-456');
    const changed = service.changePassword(login2.user.id, 'reset-pass-456', 'self-pass-789');
    assert.equal(service.authenticate(login2.token), null);
    assert.ok(service.authenticate(changed.token));
  } finally {
    cleanup();
  }
});
