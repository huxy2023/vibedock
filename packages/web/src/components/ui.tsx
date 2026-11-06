import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'default',
  size = 'default',
  className = '',
  children,
  ...props
}) => {
  const base =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 disabled:pointer-events-none disabled:opacity-50 cursor-pointer';
  const variants: Record<string, string> = {
    default: 'bg-zinc-900 text-zinc-50 shadow-xs hover:bg-zinc-900/90',
    secondary: 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200/80',
    outline: 'border border-zinc-200 bg-white text-zinc-900 shadow-2xs hover:bg-zinc-100 hover:text-zinc-900',
    ghost: 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900',
    destructive: 'bg-red-600 text-white shadow-xs hover:bg-red-600/90',
  };
  const sizes: Record<string, string> = {
    default: 'h-9 px-4 py-2',
    sm: 'h-8 rounded-md px-3 text-xs',
    lg: 'h-10 rounded-md px-6',
    icon: 'h-9 w-9',
  };
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'success' | 'danger' | 'warning';
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'secondary',
  className = '',
  children,
  ...props
}) => {
  const base =
    'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors';
  const variants: Record<string, string> = {
    default: 'border-transparent bg-zinc-900 text-zinc-50',
    secondary: 'border-transparent bg-zinc-100 text-zinc-800',
    outline: 'border-zinc-200 bg-white text-zinc-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
  };
  return (
    <span className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </span>
  );
};

export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <div
    className={`rounded-xl border border-zinc-200/90 bg-white text-zinc-950 shadow-2xs ${className}`}
    {...props}
  >
    {children}
  </div>
);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className = '', ...props }, ref) => (
  <input
    ref={ref}
    className={`flex h-9 w-full rounded-md border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-900 shadow-2xs transition-colors placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    {...props}
  />
));
Input.displayName = 'Input';

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <select
    className={`flex h-9 w-full rounded-md border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-900 shadow-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    {...props}
  >
    {children}
  </select>
);
