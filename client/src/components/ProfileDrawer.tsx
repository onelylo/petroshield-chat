import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Fingerprint, Shield, LogOut, Palette, Sun, Moon, Camera,
  Save, Loader2, Check, KeyRound, Lock, User, Bell, BellOff,
  Volume2, VolumeX, Info, Copy, ChevronRight,
} from 'lucide-react';
import type { UserKeyPair } from '../types/chat';
import { ConfirmModal } from './modals/ConfirmModal';
import { API_BASE } from '../lib/attachments';
import { showToast } from '../lib/toast';

interface ProfileDrawerProps {
  currentUser: UserKeyPair;
  userFingerprint: string;
  onClose: () => void;
  onLogout: () => void;
  onUpdateProfile: (data: { fullName?: string; email?: string; avatar?: string; username?: string; statusMessage?: string; phone?: string }) => Promise<any>;
  theme: string;
  onThemeChange: (theme: string) => void;
}

const VAULT_THEMES = [
  { id: 'vault-dark', label: 'Vault Dark', icon: Moon, color: 'bg-sky-500' },
  { id: 'slate-fusion', label: 'Slate Fusion', icon: Moon, color: 'bg-indigo-500' },
  { id: 'neon-pulse', label: 'Neon Pulse', icon: Moon, color: 'bg-pink-500' },
  { id: 'shadow-purple', label: 'Shadow Purple', icon: Moon, color: 'bg-purple-500' },
  { id: 'midnight-teal', label: 'Midnight Teal', icon: Moon, color: 'bg-teal-500' },
  { id: 'carbon-black', label: 'Carbon Black', icon: Moon, color: 'bg-neutral-900' },
  { id: 'clean-light', label: 'Clean Light', icon: Sun, color: 'bg-gray-200' },
  { id: 'amber-light', label: 'Cream Light', icon: Sun, color: 'bg-amber-200' },
  { id: 'mint-fresh', label: 'Mint Fresh', icon: Sun, color: 'bg-emerald-400' },
  { id: 'ocean-mist', label: 'Ocean Mist', icon: Sun, color: 'bg-blue-400' },
  { id: 'rose-garden', label: 'Rose Garden', icon: Sun, color: 'bg-pink-400' },
  { id: 'lavender', label: 'Lavender', icon: Sun, color: 'bg-violet-400' },
];

type TabId = 'profile' | 'appearance' | 'notifications' | 'security';

const TABS: { id: TabId; label: string; icon: React.FC<any> }[] = [
  { id: 'profile', label: 'My Account', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'security', label: 'Security', icon: Shield },
];

export const ProfileDrawer: React.FC<ProfileDrawerProps> = ({
  currentUser,
  userFingerprint,
  onClose,
  onLogout,
  onUpdateProfile,
  theme,
  onThemeChange,
}) => {
  const [username, setUsername] = useState(currentUser.username || '');
  const [email, setEmail] = useState(currentUser.email || '');
  const [phone, setPhone] = useState(currentUser.phone || '');
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('profile');
  const [soundEnabled, setSoundEnabled] = useState(localStorage.getItem('petroshield_sound') !== 'false');
  const [notificationsEnabled, setNotificationsEnabled] = useState(localStorage.getItem('petroshield_notifications') !== 'false');
  const [copiedFingerprint, setCopiedFingerprint] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem('petroshield_sound', String(soundEnabled));
  }, [soundEnabled]);

  useEffect(() => {
    localStorage.setItem('petroshield_notifications', String(notificationsEnabled));
    if (notificationsEnabled && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [notificationsEnabled]);

  // Escape key to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 256;
        let w = img.width, h = img.height;
        if (w > h && w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; }
        else if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
        setAvatarUrl(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      let finalAvatarUrl = avatarUrl;
      if (avatarUrl?.startsWith('data:')) {
        const token = localStorage.getItem('petroshield_jwt');
        if (token) {
          const res = await fetch(`${API_BASE}/api/users/me/avatar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ avatarData: avatarUrl }),
          });
          if (res.ok) { const data = await res.json(); finalAvatarUrl = data.avatarUrl; }
        }
      }
      await onUpdateProfile({ fullName: currentUser.fullName, email, avatar: finalAvatarUrl, username, phone });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('[Profile] Save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleThemeChange = (themeName: string) => {
    document.documentElement.setAttribute('data-theme', themeName);
    const userId = currentUser?.userId || 'guest';
    localStorage.setItem(`petroshield_theme_${userId}`, themeName);
    onThemeChange(themeName);
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword) return;
    setPasswordSaving(true);
    try {
      const token = localStorage.getItem('petroshield_jwt');
      const res = await fetch(`${API_BASE}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Password change failed'); }
      setPasswordSaved(true);
      setCurrentPassword('');
      setNewPassword('');
      setTimeout(() => setPasswordSaved(false), 2000);
    } catch (e: any) {
      showToast(e?.message || 'Password change failed', 'error');
    } finally {
      setPasswordSaving(false);
    }
  };

  const displayAvatar = avatarUrl || currentUser.avatarUrl;

  const hasChanges = username !== currentUser.username || email !== currentUser.email || phone !== (currentUser.phone || '') || !!avatarUrl;

  const handleClose = useCallback(() => {
    if (hasChanges) { setShaking(true); setTimeout(() => setShaking(false), 400); return; }
    onClose();
  }, [hasChanges, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[99998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleClose} />
      <div
        className="relative w-full max-w-5xl h-[85vh] max-h-[700px] flex rounded-2xl bg-[var(--bg-sidebar)] border border-[var(--border-color)] shadow-2xl text-[var(--text-main)] overflow-hidden animate-scaleIn mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar Navigation — Discord-style */}
        <div className="w-56 flex flex-col border-r border-[var(--border-color)] bg-[var(--bg-app)] shrink-0">
          <div className="p-4 border-b border-[var(--border-color)]">
            <h2 className="text-xs font-bold text-[var(--text-muted)] tracking-wider">USER SETTINGS</h2>
          </div>
          <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--hover-color)]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                  {isActive && <ChevronRight className="w-3 h-3 ml-auto shrink-0" />}
                </button>
              );
            })}
          </nav>
          <div className="p-2 border-t border-[var(--border-color)]">
            <button
              onClick={onLogout}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-rose-400 hover:bg-rose-400/10 transition-colors"
            >
              <LogOut className="w-4 h-4 shrink-0" />
              <span>Log Out</span>
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-color)] shrink-0">
            <h2 className="text-lg font-bold">{TABS.find(t => t.id === activeTab)?.label}</h2>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--hover-color)] text-[var(--text-muted)] transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col items-center">
            {activeTab === 'profile' && (
              <div className="w-full max-w-md space-y-6">
                {/* Avatar */}
                <div className="flex items-center gap-5">
                  <div
                    className="relative w-20 h-20 rounded-2xl border-2 border-[var(--border-color)] overflow-hidden cursor-pointer group shrink-0"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {displayAvatar ? (
                      <img src={displayAvatar} alt="avatar" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-[var(--bg-card)] flex items-center justify-center text-2xl font-bold text-[var(--accent-primary)]">
                        {currentUser.username.substring(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Camera className="w-6 h-6 text-white" />
                    </div>
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarFileChange} />
                  <div>
                    <div className="text-sm font-bold">{currentUser.username}</div>
                    <div className="text-xs text-[var(--text-muted)]">Click avatar to change</div>
                  </div>
                </div>

                {/* Fields */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-[var(--text-muted)] mb-1.5 tracking-wide">FULL NAME</label>
                    <input type="text" value={currentUser.fullName || ''} disabled
                      className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-xl py-2.5 px-3 text-sm text-[var(--text-muted)] cursor-not-allowed" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[var(--text-muted)] mb-1.5 tracking-wide">USERNAME</label>
                    <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                      className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-xl py-2.5 px-3 text-sm text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[var(--text-muted)] mb-1.5 tracking-wide">EMAIL</label>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                      className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-xl py-2.5 px-3 text-sm text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[var(--text-muted)] mb-1.5 tracking-wide">PHONE</label>
                    <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^0-9+\-\s()]/g, ''))}
                      placeholder="e.g. +1 555 123 4567"
                      className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-xl py-2.5 px-3 text-sm text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors" />
                  </div>
                </div>

                {/* Fingerprint */}
                <div className="p-4 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-[var(--text-muted)] tracking-wide">FINGERPRINT</span>
                    <button onClick={() => { navigator.clipboard.writeText(userFingerprint); setCopiedFingerprint(true); setTimeout(() => setCopiedFingerprint(false), 2000); }}
                      className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition-colors" title="Copy">
                      {copiedFingerprint ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Fingerprint className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
                    <span className="text-xs font-mono break-all">{userFingerprint}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span className="text-[10px] text-[var(--text-muted)]">E2EE Active</span>
                  </div>
                </div>

                {/* Save button */}
                <div className={`flex justify-end ${shaking ? 'animate-shake' : ''}`}>
                  <button onClick={() => {
                    const hasChanges2 = username !== currentUser.username || email !== currentUser.email || phone !== (currentUser.phone || '') || avatarUrl;
                    if (!hasChanges2) { setShaking(true); setTimeout(() => setShaking(false), 400); return; }
                    setShowSaveConfirm(true);
                  }} disabled={saving}
                    className="btn-shiny px-5 py-2.5 text-sm font-bold rounded-xl flex items-center gap-2 disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                    <span>{saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}</span>
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-xs font-bold text-[var(--text-muted)] mb-4 tracking-wide">THEME</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {VAULT_THEMES.map((t) => {
                      const Icon = t.icon;
                      const isActive = theme === t.id;
                      return (
                        <button
                          key={t.id}
                          onClick={() => handleThemeChange(t.id)}
                          className={`p-4 rounded-xl border-2 transition-all text-left ${
                            isActive
                              ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 shadow-[0_0_12px_var(--glow-color)]'
                              : 'border-[var(--border-color)] hover:border-[var(--text-muted)] hover:bg-[var(--hover-color)]'
                          }`}
                        >
                          <div className={`w-10 h-10 rounded-lg ${t.color} flex items-center justify-center mb-2`}>
                            <Icon className="w-5 h-5 text-white" />
                          </div>
                          <span className={`text-xs font-bold ${isActive ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'}`}>
                            {t.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="w-full max-w-md space-y-4">
                {[
                  { label: 'Message Sounds', desc: 'Play audio cues for new messages', icon: soundEnabled ? Volume2 : VolumeX, value: soundEnabled, onChange: () => setSoundEnabled(!soundEnabled) },
                  { label: 'Desktop Notifications', desc: 'Show browser notifications for messages', icon: notificationsEnabled ? Bell : BellOff, value: notificationsEnabled, onChange: () => setNotificationsEnabled(!notificationsEnabled) },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between p-4 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
                    <div className="flex items-center gap-3">
                      <item.icon className={`w-5 h-5 ${item.value ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'}`} />
                      <div>
                        <div className="text-sm font-bold">{item.label}</div>
                        <div className="text-xs text-[var(--text-muted)]">{item.desc}</div>
                      </div>
                    </div>
                    <button onClick={item.onChange}
                      className={`relative w-11 h-6 rounded-full transition-colors ${item.value ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-input)] border border-[var(--border-color)]'}`}>
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${item.value ? 'translate-x-5.5' : 'translate-x-0.5'}`}
                        style={{ transform: item.value ? 'translateX(22px)' : 'translateX(2px)' }} />
                    </button>
                  </div>
                ))}
                <div className="p-4 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
                  <div className="flex items-center gap-2 mb-2">
                    <Info className="w-4 h-4 text-[var(--accent-primary)]" />
                    <span className="text-xs font-bold text-[var(--text-muted)] tracking-wide">AUDIO SYNTHESIZER</span>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">Uses Web Audio API to generate beep tones. No external files needed.</p>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="w-full max-w-md space-y-4">
                <div className="p-4 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
                  <div className="flex items-center gap-2 mb-3">
                    <KeyRound className="w-4 h-4 text-[var(--accent-primary)]" />
                    <span className="text-xs font-bold text-[var(--text-muted)] tracking-wide">ACTIVE SESSION</span>
                  </div>
                  <div className="space-y-2">
                    {[['User', currentUser.username], ['Role', currentUser.role], ['Key Version', `v${currentUser.keyVersion ?? 1}`]].map(([k, v]) => (
                      <div key={k} className="flex justify-between text-xs">
                        <span className="text-[var(--text-muted)]">{k}</span>
                        <span className="font-bold">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-4 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
                  <div className="flex items-center gap-2 mb-3">
                    <Lock className="w-4 h-4 text-[var(--accent-primary)]" />
                    <span className="text-xs font-bold text-[var(--text-muted)] tracking-wide">CHANGE PASSWORD</span>
                  </div>
                  <div className="space-y-2">
                    <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                      className="w-full px-3 py-2.5 text-sm bg-[var(--bg-input)] border border-[var(--border-color)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]" />
                    <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full px-3 py-2.5 text-sm bg-[var(--bg-input)] border border-[var(--border-color)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]" />
                    <button onClick={handleChangePassword} disabled={!currentPassword || !newPassword || passwordSaving}
                      className="w-full py-2.5 text-xs font-bold btn-shiny rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                      {passwordSaving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>UPDATING...</span></>
                        : passwordSaved ? <><Check className="w-3.5 h-3.5" /><span>UPDATED</span></>
                        : 'UPDATE PASSWORD'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={showSaveConfirm}
        title="Save Changes"
        description="Update your profile with the changes you've made?"
        confirmLabel="Save"
        isDangerous={false}
        onConfirm={doSave}
        onClose={() => setShowSaveConfirm(false)}
      />
    </div>,
    document.body
  );
};
