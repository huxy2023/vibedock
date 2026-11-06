import React, { useState } from 'react';
import { X, KeyRound } from 'lucide-react';
import { apiFetch } from '../api';
import { Button, Card, Input } from './ui';

interface PasswordModalProps {
  open: boolean;
  onClose: () => void;
}

export const PasswordModal: React.FC<PasswordModalProps> = ({ open, onClose }) => {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      await apiFetch('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: oldPassword, newPassword }),
      });
      setSuccess('密码修改成功');
      setOldPassword('');
      setNewPassword('');
      setTimeout(() => {
        setSuccess('');
        onClose();
      }, 900);
    } catch (err) {
      setError((err as Error).message || '修改失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 backdrop-blur-2xs">
      <Card
        className="w-full max-w-md p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-modal-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-zinc-700" />
            <h3 id="password-modal-title" className="text-base font-semibold text-zinc-900">
              修改登录密码
            </h3>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 cursor-pointer"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-700">当前密码</label>
            <Input
              type="password"
              required
              placeholder="请输入当前密码"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-700">新密码</label>
            <Input
              type="password"
              required
              minLength={6}
              placeholder="请输入新密码（至少 6 位）"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {success}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? '保存中…' : '确认修改'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
};
