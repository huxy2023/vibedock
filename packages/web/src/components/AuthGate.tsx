import React, { useState } from 'react';
import { Lock, Terminal, UserPlus, LogIn } from 'lucide-react';
import { apiFetch } from '../api';
import type { User } from '../types';
import { Button, Card, Input } from './ui';

interface AuthGateProps {
  onAuthenticated: (user: User) => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body =
        mode === 'register'
          ? { username: username.trim(), password, inviteCode: inviteCode.trim() }
          : { username: username.trim(), password };
      const data = await apiFetch<{ user: User }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onAuthenticated(data.user);
    } catch (err) {
      setError((err as Error).message || '请求失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      id="auth-gate"
      className="relative flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-12"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(#e4e4e7_1px,transparent_1px)] [background-size:20px_20px] opacity-60" />

      <Card className="relative z-10 w-full max-w-md p-8 shadow-lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-900 text-white shadow-xs">
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">VibeDock 门户</h1>
            <p className="text-xs text-zinc-500">AI-Native 团队应用与数据库私有云</p>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 rounded-lg bg-zinc-100 p-1">
          <button
            type="button"
            className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all cursor-pointer ${
              mode === 'login'
                ? 'bg-white text-zinc-900 shadow-2xs'
                : 'text-zinc-600 hover:text-zinc-900'
            }`}
            onClick={() => {
              setMode('login');
              setError('');
            }}
          >
            <LogIn className="h-3.5 w-3.5" />
            账号登录
          </button>
          <button
            type="button"
            className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all cursor-pointer ${
              mode === 'register'
                ? 'bg-white text-zinc-900 shadow-2xs'
                : 'text-zinc-600 hover:text-zinc-900'
            }`}
            onClick={() => {
              setMode('register');
              setError('');
            }}
          >
            <UserPlus className="h-3.5 w-3.5" />
            邀请码注册
          </button>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-700">用户名</label>
            <Input
              type="text"
              required
              autoComplete="username"
              placeholder="例如 admin 或 zhangsan"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-700">密码</label>
            <Input
              type="password"
              required
              autoComplete="current-password"
              placeholder="请输入密码（至少 6 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {mode === 'register' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-700">团队注册邀请码</label>
              <Input
                type="text"
                required
                placeholder="向管理员索取邀请码，例如 team-xxxxxx"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            <Lock className="h-4 w-4" />
            {loading ? '处理中…' : mode === 'register' ? '注册并进入门户' : '登录进入门户'}
          </Button>
        </form>
      </Card>
    </div>
  );
};
