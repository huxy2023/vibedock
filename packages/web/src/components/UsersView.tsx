import React, { useState, useEffect } from 'react';
import { Copy, Check, UserPlus, Trash2, KeyRound, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../api';
import { Badge, Button, Card, Input, Select } from './ui';

interface AdminUserRecord {
  id: string;
  username: string;
  displayName?: string;
  role: 'admin' | 'member';
  createdAt?: string;
}

export const UsersView: React.FC = () => {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [inviteCode, setInviteCode] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'member' | 'admin'>('member');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const loadData = async () => {
    try {
      const res = await apiFetch<{ users: AdminUserRecord[]; inviteCode: string }>(
        '/api/auth/users'
      );
      setUsers(res.users || []);
      setInviteCode(res.inviteCode || '');
      setInviteInput(res.inviteCode || '');
    } catch (err) {
      setError((err as Error).message || '加载失败');
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSaveInviteCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await apiFetch<{ inviteCode: string }>('/api/auth/invite-code', {
        method: 'PUT',
        body: JSON.stringify({ inviteCode: inviteInput.trim() }),
      });
      setInviteCode(res.inviteCode || '');
    } catch (err) {
      setError((err as Error).message || '保存失败');
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/api/auth/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
          role: newRole,
        }),
      });
      setNewUsername('');
      setNewPassword('');
      await loadData();
    } catch (err) {
      setError((err as Error).message || '创建用户失败');
    }
  };

  const handleToggleRole = async (u: AdminUserRecord) => {
    const nextRole = u.role === 'admin' ? 'member' : 'admin';
    setError('');
    try {
      await apiFetch(`/api/auth/users/${encodeURIComponent(u.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ role: nextRole }),
      });
      await loadData();
    } catch (err) {
      setError((err as Error).message || '更新角色失败');
    }
  };

  const handleResetPassword = async (u: AdminUserRecord) => {
    const pwd = window.prompt(`请为成员「${u.username}」输入新密码（至少 6 位）：`);
    if (!pwd) return;
    setError('');
    try {
      await apiFetch(`/api/auth/users/${encodeURIComponent(u.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ password: pwd }),
      });
      await loadData();
    } catch (err) {
      setError((err as Error).message || '重置密码失败');
    }
  };

  const handleDeleteUser = async (userId: string, username: string) => {
    if (!window.confirm(`确定要移除成员「${username}」吗？`)) return;
    try {
      await apiFetch(`/api/auth/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      });
      await loadData();
    } catch (err) {
      setError((err as Error).message || '删除失败');
    }
  };

  const copyInvite = async () => {
    if (!inviteCode) return;
    await navigator.clipboard.writeText(inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">团队注册邀请码</h2>
            <p className="mt-1 text-xs text-zinc-500">
              向新研发成员发放邀请码，成员可自助在登录页注册账号（留空保存可关闭自助注册）
            </p>
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={handleSaveInviteCode}>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-zinc-700">当前邀请码</label>
              <Input
                type="text"
                className="w-52 font-mono"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                placeholder="例如 team-2026"
              />
            </div>
            <Button type="submit">保存邀请码</Button>
            {inviteCode && (
              <Button type="button" variant="outline" onClick={copyInvite}>
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    复制邀请码
                  </>
                )}
              </Button>
            )}
          </form>
        </div>
        {error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-col justify-between gap-4 border-b border-zinc-200 p-6 lg:flex-row lg:items-end">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              团队成员列表 ({users.length})
            </h2>
            <p className="mt-1 text-xs text-zinc-500">当前拥有门户访问权限的账号</p>
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={handleCreateUser}>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-zinc-700">新成员用户名</label>
              <Input
                type="text"
                required
                className="w-36"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="zhangsan"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-zinc-700">初始密码</label>
              <Input
                type="password"
                required
                minLength={6}
                className="w-36"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 6 位"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-zinc-700">角色</label>
              <Select
                className="w-32"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as 'member' | 'admin')}
              >
                <option value="member">普通成员</option>
                <option value="admin">管理员</option>
              </Select>
            </div>
            <Button type="submit">
              <UserPlus className="h-4 w-4" />
              添加成员
            </Button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50/80 text-zinc-500">
                <th className="px-6 py-3 font-medium">用户名</th>
                <th className="px-6 py-3 font-medium">角色权限</th>
                <th className="px-6 py-3 font-medium">创建时间</th>
                <th className="px-6 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-zinc-50/60">
                  <td className="px-6 py-3.5 font-semibold text-zinc-900">{u.username}</td>
                  <td className="px-6 py-3.5">
                    <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>
                      {u.role === 'admin' ? '管理员 (Admin)' : '普通成员 (Member)'}
                    </Badge>
                  </td>
                  <td className="px-6 py-3.5 font-mono text-zinc-500">
                    {u.createdAt ? u.createdAt.slice(0, 19).replace('T', ' ') : '-'}
                  </td>
                  <td className="px-6 py-3.5">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleResetPassword(u)}
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        重置密码
                      </Button>
                      {u.username !== 'admin' && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleToggleRole(u)}
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            {u.role === 'admin' ? '设为普通成员' : '设为管理员'}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDeleteUser(u.id, u.username)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            移除
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
};
