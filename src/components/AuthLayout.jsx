import React, { useEffect } from "react";
import Logo from '@/components/phd/Logo';

export default function AuthLayout({ title, subtitle, footer, children }) {
  useEffect(() => { const dark = localStorage.getItem('phd-theme') === 'dark'; document.documentElement.classList.toggle('dark', dark); document.documentElement.dataset.theme = dark ? 'dark' : 'clean'; }, []);
  return (
    <div className="phd-auth min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="auth-brand"><Logo theme={localStorage.getItem('phd-theme') === 'dark' ? 'dark' : 'clean'} /></div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-2">{subtitle}</p>}
        </div>
        <div className="auth-card">
          {children}
        </div>
        {footer && (
          <p className="text-center text-sm text-muted-foreground mt-6">{footer}</p>
        )}
      </div>
    </div>
  );
}