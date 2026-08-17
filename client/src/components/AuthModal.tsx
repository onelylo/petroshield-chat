import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, ArrowRight, Loader2, Cpu, ShieldAlert, Lock, User as UserIcon, Mail } from 'lucide-react';
import type { UserRole } from '../types/chat';

interface AuthModalProps {
  onAuthenticate: (params: {
    username: string;
    fullName?: string;
    email?: string;
    password: string;
    role: UserRole;
    isRegister: boolean;
  }) => Promise<void>;
  error?: string | null;
}

export const AuthModal: React.FC<AuthModalProps> = ({ onAuthenticate, error: authError }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stayLoggedIn, setStayLoggedIn] = useState(() => {
    try { return localStorage.getItem('petroshield_stayLoggedIn') !== 'false'; } catch { return true; }
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      await onAuthenticate({ username: username.trim(), fullName: fullName.trim() || username.trim(), email: email.trim(), password, role: 'MEMBER', isRegister });
    } catch (err: any) {
      setError(err?.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTabChange = (register: boolean) => {
    setIsRegister(register);
    setError(null);
    setUsername('');
    setFullName('');
    setEmail('');
    setPassword('');
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(8px)' }}>
      <div 
        className="w-full max-w-sm rounded-2xl shadow-2xl relative overflow-hidden font-mono"
        style={{ 
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px var(--glow-color)'
        }}
      >
        {/* Top accent line */}
        <div className="h-1" style={{ background: 'linear-gradient(90deg, transparent, var(--accent-primary), transparent)' }} />

        <div className="p-6">
          {/* Header */}
          <div className="text-center mb-5">
            <div 
              className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center"
              style={{ 
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                boxShadow: '0 0 15px var(--glow-color)'
              }}
            >
              <ShieldCheck className="w-7 h-7" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <h1 className="text-lg font-bold tracking-wider" style={{ color: 'var(--text-main)' }}>
              PetroShield
            </h1>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              SECURE ENTERPRISE MESSENGER
            </p>
          </div>

          {/* Tab Switcher */}
          <div 
            className="flex rounded-lg p-0.5 mb-5"
            style={{ 
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)'
            }}
          >
            {[
              { label: 'Sign In', active: false },
              { label: 'Register', active: true }
            ].map(({ label, active }) => (
              <button
                key={label}
                type="button"
                onClick={() => handleTabChange(active)}
                className="flex-1 py-2 text-[11px] font-bold rounded-md transition-all duration-200"
                style={{
                  backgroundColor: isRegister === active ? 'var(--accent-primary)' : 'transparent',
                  color: isRegister === active ? 'var(--bg-surface)' : 'var(--text-muted)',
                  boxShadow: isRegister === active ? '0 2px 8px var(--glow-color)' : 'none'
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Error Message */}
          {(error || authError) && (
            <div 
              className="p-2.5 rounded-lg text-xs flex items-center space-x-2 mb-4"
              style={{ 
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171'
              }}
            >
              <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-[11px]">{error || authError}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Username */}
            <div>
              <label className="block text-[10px] font-bold mb-1 tracking-wider" style={{ color: 'var(--text-muted)' }}>
                USERNAME
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                disabled={loading}
                placeholder="Enter username"
                required
                className="w-full rounded-lg px-3 py-2.5 text-sm transition-all focus:outline-none focus:ring-2"
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-main)',
                  '--tw-ring-color': 'var(--accent-primary)'
                } as React.CSSProperties}
              />
            </div>

            {/* Register-only fields */}
            {isRegister && (
              <>
                <div>
                  <label className="block text-[10px] font-bold mb-1 tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    FULL NAME
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={fullName}
                      onChange={e => setFullName(e.target.value)}
                      disabled={loading}
                      placeholder="Your full name"
                      className="w-full rounded-lg px-3 py-2.5 text-sm transition-all focus:outline-none focus:ring-2 pr-8"
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-main)',
                        '--tw-ring-color': 'var(--accent-primary)'
                      } as React.CSSProperties}
                    />
                    <UserIcon className="w-3.5 h-3.5 absolute right-2.5 top-2.5" style={{ color: 'var(--text-muted)' }} />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold mb-1 tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    EMAIL
                  </label>
                  <div className="relative">
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      disabled={loading}
                      placeholder="you@company.com"
                      className="w-full rounded-lg px-3 py-2.5 text-sm transition-all focus:outline-none focus:ring-2 pr-8"
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-main)',
                        '--tw-ring-color': 'var(--accent-primary)'
                      } as React.CSSProperties}
                    />
                    <Mail className="w-3.5 h-3.5 absolute right-2.5 top-2.5" style={{ color: 'var(--text-muted)' }} />
                  </div>
                </div>
              </>
            )}

            {/* Password */}
            <div>
              <label className="block text-[10px] font-bold mb-1 tracking-wider" style={{ color: 'var(--text-muted)' }}>
                PASSWORD
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={loading}
                  placeholder="••••••••"
                  required
                  className="w-full rounded-lg px-3 py-2.5 text-sm transition-all focus:outline-none focus:ring-2 pr-8"
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-main)',
                    '--tw-ring-color': 'var(--accent-primary)'
                  } as React.CSSProperties}
                />
                <Lock className="w-3.5 h-3.5 absolute right-2.5 top-2.5" style={{ color: 'var(--text-muted)' }} />
              </div>
            </div>

            {/* Stay logged in */}
            {!isRegister && (
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={stayLoggedIn}
                    onChange={e => {
                      setStayLoggedIn(e.target.checked);
                      localStorage.setItem('petroshield_stayLoggedIn', String(e.target.checked));
                    }}
                    className="w-3.5 h-3.5 rounded accent-[var(--accent-primary)]"
                  />
                  <span className="text-[10px] font-bold" style={{ color: 'var(--text-muted)' }}>Stay logged in</span>
                </label>
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  {stayLoggedIn ? 'Keeps you signed in' : 'This session only'}
                </span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={!username.trim() || !password || loading}
              className="w-full py-2.5 px-4 rounded-lg font-bold text-xs tracking-wider flex items-center justify-center space-x-2 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed mt-4"
              style={{
                backgroundColor: 'var(--accent-primary)',
                color: 'var(--bg-surface)',
                boxShadow: '0 4px 15px var(--glow-color)'
              }}
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>AUTHENTICATING...</span>
                </>
              ) : (
                <>
                  <span>{isRegister ? 'CREATE ACCOUNT' : 'SIGN IN'}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </form>

          {/* Security Badge */}
          <div 
            className="mt-4 p-2 rounded-lg flex items-center justify-center space-x-2"
            style={{ 
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)'
            }}
          >
            <Cpu className="w-3 h-3" style={{ color: '#34d399' }} />
            <p className="text-[9px] font-bold" style={{ color: 'var(--text-muted)' }}>
              E2EE · AES-256-GCM · ECDH-P256
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
