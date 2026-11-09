import React, { useState, useEffect, useRef } from 'react';
import {
  LayoutGrid,
  Rocket,
  Bot,
  Users,
  KeyRound,
  LogOut,
  Terminal,
  ChevronDown,
} from 'lucide-react';
import type { HostSystemSummary, User, ViewTab } from '../types';
import { Badge } from './ui';

interface HeaderProps {
  user: User;
  activeView: ViewTab;
  onSelectView: (view: ViewTab) => void;
  onlineCount: number;
  totalCount: number;
  system?: HostSystemSummary | null;
  onOpenPasswordModal: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  activeView,
  onSelectView,
  onlineCount,
  totalCount,
  system,
  onOpenPasswordModal,
  onLogout,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const allHealthy = totalCount === 0 || onlineCount === totalCount;
  const healthLabel =
    totalCount === 0
      ? '暂无服务'
      : allHealthy
      ? `${onlineCount}/${totalCount} 在线`
      : `${onlineCount}/${totalCount} 部分离线`;

  const avatarChar = (user.username || 'U').slice(0, 1).toUpperCase();

  const navItems: Array<{ id: ViewTab; label: string; icon: React.ReactNode }> = [
    { id: 'catalog', label: '项目导航', icon: <LayoutGrid className="h-4 w-4" /> },
    { id: 'deploy', label: '开发者中心', icon: <Rocket className="h-4 w-4" /> },
    { id: 'assistant', label: '运维助手', icon: <Bot className="h-4 w-4" /> },
    ...(user.role === 'admin'
      ? [{ id: 'users' as ViewTab, label: '成员与邀请码', icon: <Users className="h-4 w-4" /> }]
      : []),
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/95 backdrop-blur-xs">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3 shrink-0 whitespace-nowrap">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white shadow-2xs">
            <Terminal className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight text-zinc-900">VibeDock</span>
            <span className="hidden text-zinc-300 lg:inline">/</span>
            <span className="hidden text-xs font-medium text-zinc-500 lg:inline">
              研发与演示门户
            </span>
          </div>
          <Badge variant={allHealthy ? 'success' : 'warning'} className="ml-1 shrink-0 whitespace-nowrap">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                allHealthy ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
            />
            {healthLabel}
          </Badge>
        </div>

        <nav className="flex shrink-0 items-center gap-1 rounded-lg bg-zinc-100/80 p-1 whitespace-nowrap" aria-label="主视图切换">
          {navItems.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                  active
                    ? 'bg-white text-zinc-900 shadow-2xs'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="relative shrink-0 whitespace-nowrap" ref={menuRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen((prev) => !prev)}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 shadow-2xs transition-colors hover:bg-zinc-50 cursor-pointer"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white">
              {avatarChar}
            </span>
            <span className="max-w-[100px] truncate">{user.username}</span>
            <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
              {user.role === 'admin' ? '管理员' : '成员'}
            </Badge>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 mt-1.5 w-44 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-zinc-700 hover:bg-zinc-100 cursor-pointer"
                onClick={() => {
                  setDropdownOpen(false);
                  onOpenPasswordModal();
                }}
              >
                <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
                修改登录密码
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-red-600 hover:bg-red-50 cursor-pointer"
                onClick={() => {
                  setDropdownOpen(false);
                  onLogout();
                }}
              >
                <LogOut className="h-3.5 w-3.5" />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
