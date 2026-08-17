import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck,
  RefreshCw,
  X,
  KeyRound,
  Loader2,
  Users,
  Activity,
  Wifi,
  WifiOff,
  Crown,
  Settings,
  Database,
  HardDrive,
  Server,
  MemoryStick,
  Clock,
  Lock,
  FolderOpen,
  Cpu
} from 'lucide-react';
import type { AdminUser, UserKeyPair, UserRole } from '../types/chat';
import { getFingerprint } from '../lib/crypto';
import { API_BASE } from '../lib/attachments';
import { EditUserModal } from './admin/EditUserModal';
import { AdminUserTable } from './admin/AdminUserTable';
import { ConfirmDialog } from './ConfirmDialog';

interface AdminDashboardProps {
  currentUser: UserKeyPair;
  fetchUsers: () => Promise<AdminUser[]>;
  onSetRole: (userId: string, role: UserRole) => Promise<boolean>;
  onDeleteUser: (userId: string) => Promise<boolean>;
  onClose: () => void;
  activeTab: 'overview' | 'users' | 'infrastructure';
}

interface AdminStats {
  users: number;
  channels: number;
  messages: number;
  attachments: number;
  onlineUsers: number;
  offlineUsers: number;
  admins: number;
  members: number;
  activeSockets: number;
}

interface HealthData {
  server: { uptime: number; uptimePretty: string; nodeVersion: string; platform: string; arch: string };
  memory: { rss: number; heapUsed: number; heapTotal: number; rssPretty: string; heapUsedPretty: string };
  database: { sizeBytes: number; sizePretty: string };
  storage: { uploadsBytes: number; uploadsPretty: string; fileCount: number };
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  currentUser,
  fetchUsers,
  onSetRole,
  onDeleteUser,
  onClose,
  activeTab,
}) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    variant: 'danger' | 'primary';
    onConfirm: () => Promise<void>;
  } | null>(null);

  const loadStats = useCallback(async () => {
    const token = localStorage.getItem('petroshield_jwt');
    if (!token) return;
    try {
      const [statsRes, healthRes] = await Promise.all([
        fetch(`${API_BASE}/api/admin/stats`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_BASE}/api/admin/health`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (statsRes.ok) setStats(await statsRes.json());
      if (healthRes.ok) setHealth(await healthRes.json());
    } catch (e) {
      console.error('[Admin] Data fetch error:', e);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    await loadStats();
    const list = await fetchUsers();
    setUsers(list);
    const map: Record<string, string> = {};
    for (const u of list) {
      if (u.publicKey) map[u.userId] = await getFingerprint(u.publicKey);
    }
    setFingerprints(map);
    setLoading(false);
  }, [fetchUsers, loadStats]);

  useEffect(() => { load(); }, [load]);

  const handleToggleRole = async (user: AdminUser) => {
    if (user.userId === currentUser.userId) return;
    const roleCycle: UserRole[] = ['MEMBER', 'SUPERVISOR', 'ADMIN'];
    const currentIdx = roleCycle.indexOf(user.role);
    const next: UserRole = roleCycle[(currentIdx + 1) % roleCycle.length];
    setConfirmDialog({
      isOpen: true,
      title: 'Change Role',
      message: `Change ${user.username}'s role to <strong>${next}</strong>?`,
      variant: 'primary',
      onConfirm: async () => {
        setBusyId(user.userId);
        const ok = await onSetRole(user.userId, next);
        setBusyId(null);
        if (ok) await load();
      },
    });
  };

  const handleDelete = async (user: AdminUser) => {
    if (user.userId === currentUser.userId) return;
    setConfirmDialog({
      isOpen: true,
      title: 'Delete User',
      message: `Delete <strong>${user.username}</strong>? This will remove their account. Message history and encryption keys will be preserved so existing conversations remain decryptable. <strong>This cannot be undone.</strong>`,
      variant: 'danger',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        setBusyId(user.userId);
        const ok = await onDeleteUser(user.userId);
        setBusyId(null);
        if (ok) await load();
      },
    });
  };

  const handleEditUser = (user: AdminUser) => {
    if (user.userId === currentUser.userId) return;
    setEditingUser(user);
  };

  const handleSaveUser = async (data: { userId: string; role: string; fullName: string; email?: string; username?: string; status: string; phone?: string; newPassword?: string; revokeKeys?: boolean }) => {
    const token = localStorage.getItem('petroshield_jwt') || sessionStorage.getItem('petroshield_jwt');
    if (!token) return;

    // Role change
    if (data.role !== users.find(u => u.userId === data.userId)?.role) {
      const ok = await onSetRole(data.userId, data.role as UserRole);
      if (!ok) return;
    }

    // Profile fields (fullName, phone, email, username)
    try {
      await fetch(`${API_BASE}/api/admin/users/${data.userId}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fullName: data.fullName, phone: data.phone, email: data.email, username: data.username }),
      });
    } catch {}

    // Status change (ACTIVE/SUSPENDED)
    const currentUser = users.find(u => u.userId === data.userId);
    if (data.status !== (currentUser?.status || 'ACTIVE')) {
      try {
        await fetch(`${API_BASE}/api/admin/users/${data.userId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: data.status }),
        });
      } catch {}
    }

    // Force password reset
    if (data.newPassword) {
      try {
        await fetch(`${API_BASE}/api/admin/users/${data.userId}/password`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ newPassword: data.newPassword }),
        });
      } catch {}
    }

    // Revoke E2EE keys
    if (data.revokeKeys) {
      try {
        await fetch(`${API_BASE}/api/admin/users/${data.userId}/revoke-keys`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        });
      } catch {}
    }

    await load();
    setEditingUser(null);
  };

  const adminCount = users.filter(u => u.role === 'ADMIN').length;
  const onlineCount = users.filter(u => u.isOnline).length;

  const StatCard: React.FC<{
    icon: React.ReactNode;
    label: string;
    value: number | string;
    iconBg: string;
    iconColor: string;
    subtext?: string;
  }> = ({ icon, label, value, iconBg, iconColor, subtext }) => (
    <div className="rounded-xl p-4 transition-smooth" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-primary)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
    >
      <div className="flex items-center space-x-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: iconBg, border: `1px solid ${iconColor}33` }}>
          {icon}
        </div>
        <div>
          <div className="text-2xl font-bold" style={{ color: 'var(--text-main)' }}>{value}</div>
          <div className="text-[10px] tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</div>
          {subtext && <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{subtext}</div>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-main)' }}>
      {/* Header */}
      <header className="h-16 px-6 flex items-center justify-between flex-shrink-0 z-10 select-none" style={{ backgroundColor: 'var(--bg-surface)', borderBottom: '1px solid var(--border-color)' }}>
        <div className="flex items-center space-x-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}
          >
            <ShieldCheck className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h3 className="font-bold text-sm flex items-center space-x-2" style={{ color: 'var(--text-main)' }}>
              <span>ADMIN CONTROL CENTER</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--accent-primary)' }}>RBAC</span>
            </h3>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Zero-Trust · {users.length} users · {onlineCount} online · {adminCount} admins
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={load}
            title="Refresh data"
            className="w-10 h-10 rounded-lg flex items-center justify-center transition-smooth"
            style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent-primary)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            title="Back to workspace"
            className="w-10 h-10 rounded-lg flex items-center justify-center transition-smooth"
            style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-main)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-6xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> LOADING ADMIN DATA…
            </div>
          ) : (
            <>
              {/* Overview Tab */}
              {activeTab === 'overview' && (
                <div className="space-y-6 animate-fadeIn">
                  {/* Zero-Trust Banner */}
                  <div className="p-4 rounded-xl text-[11px] leading-relaxed flex items-start space-x-3" style={{ backgroundColor: 'rgba(52, 211, 153, 0.05)', border: '1px solid rgba(52, 211, 153, 0.2)' }}>
                    <ShieldCheck className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#34d399' }} />
                    <div style={{ color: 'var(--text-muted)' }}>
                      <span style={{ color: '#34d399' }} className="font-bold">ZERO-TRUST PRINCIPLE: </span>
                      This dashboard monitors infrastructure health only. Message content, attachment data, and user activity
                      are <span style={{ color: '#34d399' }} className="font-bold">never</span> accessible to administrators. All data is end-to-end encrypted.
                    </div>
                  </div>

                  {/* Stats Grid */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard
                      icon={<Users className="w-5 h-5" style={{ color: '#60a5fa' }} />}
                      label="TOTAL USERS"
                      value={stats?.users || users.length}
                      iconBg="rgba(96, 165, 250, 0.1)"
                      iconColor="#60a5fa"
                      subtext={`${onlineCount} online`}
                    />
                    <StatCard
                      icon={<KeyRound className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />}
                      label="KEY PAIRS"
                      value={stats?.users || users.length}
                      iconBg="color-mix(in srgb, var(--accent-primary) 10%, transparent)"
                      iconColor="var(--accent-primary)"
                      subtext="Active E2EE identities"
                    />
                    <StatCard
                      icon={<Database className="w-5 h-5" style={{ color: '#a78bfa' }} />}
                      label="DATABASE"
                      value={health?.database.sizePretty || '—'}
                      iconBg="rgba(167, 139, 250, 0.1)"
                      iconColor="#a78bfa"
                      subtext="Encrypted storage"
                    />
                    <StatCard
                      icon={<FolderOpen className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />}
                      label="ATTACHMENTS"
                      value={health?.storage.fileCount ?? stats?.attachments ?? 0}
                      iconBg="color-mix(in srgb, var(--accent-primary) 10%, transparent)"
                      iconColor="var(--accent-primary)"
                      subtext={health?.storage.uploadsPretty || 'Encrypted files'}
                    />
                  </div>

                  {/* System Status */}
                  <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                    <h4 className="text-xs font-bold tracking-wider mb-4 flex items-center space-x-2" style={{ color: 'var(--text-muted)' }}>
                      <Activity className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                      <span>SYSTEM STATUS</span>
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="flex items-center space-x-2">
                        <Wifi className="w-4 h-4" style={{ color: '#34d399' }} />
                        <div>
                          <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>{stats?.onlineUsers || onlineCount}</div>
                          <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Online Users</div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <WifiOff className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                        <div>
                          <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>{stats?.offlineUsers || (users.length - onlineCount)}</div>
                          <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Offline Users</div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Crown className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                        <div>
                          <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>{stats?.admins || adminCount}</div>
                          <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Admins</div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Users className="w-4 h-4" style={{ color: '#60a5fa' }} />
                        <div>
                          <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>{stats?.members || (users.length - adminCount)}</div>
                          <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Members</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Security Posture */}
                  <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                    <h4 className="text-xs font-bold tracking-wider mb-4 flex items-center space-x-2" style={{ color: 'var(--text-muted)' }}>
                      <Lock className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                      <span>SECURITY POSTURE</span>
                    </h4>
                    <div className="space-y-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {[
                        'End-to-end encryption — admin cannot read message content',
                        'ECDSA dual-key signing with rotation chain verification',
                        'Trust On First Use (TOFU) key pinning for all users',
                        'Soft-delete tombstone records — no data resurrection',
                        'Zero-knowledge admin — no message/attachment content access',
                      ].map((item, i) => (
                        <div key={i} className="flex items-start space-x-2">
                          <span style={{ color: '#34d399' }}>✓</span>
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Users Tab */}
              {activeTab === 'users' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="p-4 rounded-xl text-[11px] leading-relaxed" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                    <span style={{ color: '#34d399' }} className="font-bold">RBAC POLICY: </span>
                    Only ADMIN-role accounts may manage users. Role changes and deletions broadcast to all connected clients in real time via{' '}
                    <span style={{ color: 'var(--accent-primary)' }}>user:role_change</span> / <span style={{ color: 'var(--accent-primary)' }}>user:removed</span> events. No message content is accessed.
                  </div>
                  <AdminUserTable
                    users={users}
                    currentUser={currentUser}
                    fingerprints={fingerprints}
                    busyId={busyId}
                    onEditUser={handleEditUser}
                    onToggleRole={handleToggleRole}
                    onDelete={handleDelete}
                  />
                </div>
              )}

              {/* Infrastructure Tab */}
              {activeTab === 'infrastructure' && (
                <div className="space-y-6 animate-fadeIn">
                  <div className="p-4 rounded-xl text-[11px] leading-relaxed flex items-start space-x-3" style={{ backgroundColor: 'rgba(52, 211, 153, 0.05)', border: '1px solid rgba(52, 211, 153, 0.2)' }}>
                    <ShieldCheck className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#34d399' }} />
                    <div style={{ color: 'var(--text-muted)' }}>
                      <span style={{ color: '#34d399' }} className="font-bold">INFRASTRUCTURE ONLY: </span>
                      This panel shows server health and storage metrics. No user content, message data, or attachment content is monitored or logged.
                    </div>
                  </div>

                  {/* Server Health */}
                  <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                    <h4 className="text-xs font-bold tracking-wider mb-4 flex items-center space-x-2" style={{ color: 'var(--text-muted)' }}>
                      <Server className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                      <span>SERVER HEALTH</span>
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {[
                        { icon: <Clock className="w-4 h-4" style={{ color: '#34d399' }} />, label: 'UPTIME', value: health?.server.uptimePretty || '—', sub: null },
                        { icon: <Cpu className="w-4 h-4" style={{ color: '#60a5fa' }} />, label: 'RUNTIME', value: health?.server.nodeVersion || '—', sub: `${health?.server.platform} · ${health?.server.arch}` },
                        { icon: <Wifi className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />, label: 'SOCKETS', value: stats?.activeSockets || 0, sub: 'Active connections' },
                      ].map((item, i) => (
                        <div key={i} className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
                          <div className="flex items-center space-x-2 mb-2">
                            {item.icon}
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                          </div>
                          <div className="text-lg font-bold" style={{ color: 'var(--text-main)' }}>{item.value}</div>
                          {item.sub && <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{item.sub}</div>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Memory Usage */}
                  <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                    <h4 className="text-xs font-bold tracking-wider mb-4 flex items-center space-x-2" style={{ color: 'var(--text-muted)' }}>
                      <MemoryStick className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                      <span>MEMORY USAGE</span>
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
                        <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Heap Used</div>
                        <div className="text-lg font-bold" style={{ color: 'var(--text-main)' }}>{health?.memory.heapUsedPretty || '—'}</div>
                        {health && (
                          <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border-color)' }}>
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${Math.min(100, (health.memory.heapUsed / health.memory.heapTotal) * 100)}%`, backgroundColor: '#34d399' }}
                            />
                          </div>
                        )}
                      </div>
                      <div className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
                        <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>RSS (Total)</div>
                        <div className="text-lg font-bold" style={{ color: 'var(--text-main)' }}>{health?.memory.rssPretty || '—'}</div>
                        <div className="text-[9px] mt-2" style={{ color: 'var(--text-muted)' }}>Resident set size</div>
                      </div>
                    </div>
                  </div>

                  {/* Storage Quota */}
                  <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                    <h4 className="text-xs font-bold tracking-wider mb-4 flex items-center space-x-2" style={{ color: 'var(--text-muted)' }}>
                      <HardDrive className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                      <span>STORAGE QUOTA</span>
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                      {[
                        { icon: <Database className="w-4 h-4" style={{ color: '#a78bfa' }} />, label: 'DATABASE', value: health?.database.sizePretty || '—', sub: 'PostgreSQL storage' },
                        { icon: <FolderOpen className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />, label: 'UPLOADS', value: health?.storage.uploadsPretty || '—', sub: `${health?.storage.fileCount ?? 0} encrypted files` },
                      ].map((item, i) => (
                        <div key={i} className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                          <div className="flex items-center space-x-2 mb-2">
                            {item.icon}
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                          </div>
                          <div className="text-lg font-bold" style={{ color: 'var(--text-main)' }}>{item.value}</div>
                          <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{item.sub}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Connection Info */}
                  <div className="rounded-xl p-5" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                    <h4 className="text-xs font-bold tracking-wider mb-4 flex items-center space-x-2" style={{ color: 'var(--text-muted)' }}>
                      <Lock className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                      <span>CONNECTION INFO</span>
                    </h4>
                    <div className="space-y-3">
                      {[
                        { label: 'Database Status', value: <span className="flex items-center space-x-1" style={{ color: '#34d399' }}><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#34d399' }} /><span className="font-bold">Connected</span></span> },
                        { label: 'Encryption Engine', value: <span className="font-bold" style={{ color: 'var(--accent-primary)' }}>AES-256-GCM + ECDH P-256</span> },
                        { label: 'Signing Algorithm', value: <span className="font-bold" style={{ color: 'var(--accent-primary)' }}>ECDSA P-256</span> },
                      ].map((item, i) => (
                        <div key={i} className="flex items-center justify-between py-2" style={{ borderBottom: i < 2 ? '1px solid var(--border-color)' : 'none' }}>
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                          <span className="text-[11px]">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <EditUserModal
        user={editingUser ? {
          id: editingUser.userId,
          username: editingUser.username,
          fullName: editingUser.fullName,
          email: editingUser.email,
          role: editingUser.role,
          status: editingUser.status || 'ACTIVE',
          phone: editingUser.phone,
        } : null}
        isOpen={!!editingUser}
        onClose={() => setEditingUser(null)}
        onSave={handleSaveUser}
      />
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title || ''}
        message={confirmDialog?.message || ''}
        confirmLabel={confirmDialog?.confirmLabel || 'Confirm'}
        variant={confirmDialog?.variant || 'primary'}
        onConfirm={async () => { await confirmDialog?.onConfirm(); setConfirmDialog(null); }}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
};
