import React, { useState, useEffect, useCallback } from 'react';
import { liveQuery } from 'dexie';
import {
  ShieldCheck,
  MessageSquare,
  Hash,
  Plus,
  Search,
  X,
  Lock,
  ChevronLeft,
  ChevronRight,
  Shield,
  UserCog,
  UserPlus,
  MessageCircle,
  Settings,
  Users,
  Activity,
  Server,
  VolumeX,
  Volume2,
  XCircle,
} from 'lucide-react';
import type { User, Channel, UserKeyPair } from '../types/chat';
import { getFingerprint } from '../lib/crypto';
import { db, getActiveDMPartners, getMutedConversations, muteConversation, unmuteConversation, getBlockedUsers, getHiddenConversations, hideConversation, unhideConversation } from '../lib/db';
import { CreateChannelModal } from './channels/CreateChannelModal';

interface SidebarProps {
  users: User[];
  channels: Channel[];
  currentUser: UserKeyPair | null;
  selectedUser: User | null;
  selectedChannel: Channel | null;
  activeView: 'channels' | 'dms';
  adminTab: 'overview' | 'users' | 'infrastructure';
  userFingerprint: string;
  isAdmin: boolean;
  showAdmin: boolean;
  onSelectView: (view: 'channels' | 'dms') => void;
  onSelectUser: (user: User) => void;
  onSelectChannel: (channel: Channel) => void;
  onCreateChannel: (channel: { name: string; description: string; type: 'official' | 'team' | 'private'; isAnnouncement?: boolean; memberIds?: string[] }) => void;
  onShowFingerprintModal: () => void;
  onOpenProfileDrawer: () => void;
  onToggleAdmin: () => void;
  onSelectAdminTab: (tab: 'overview' | 'users' | 'infrastructure') => void;
  onLogout: () => void;
  onOpenChannelSettings: (channel: Channel) => void;
  unreadDMs?: Record<string, number>;
  unreadChannels?: Record<string, number>;
  recentDMs?: User[];
  latestDMMessages?: Record<string, string>;
  onCloseDM?: (userId: string) => void;
  hiddenConversations?: Set<string>;
}

export const Sidebar: React.FC<SidebarProps> = ({
  users,
  channels,
  currentUser,
  selectedUser,
  selectedChannel,
  activeView,
  adminTab,
  userFingerprint,
  isAdmin,
  showAdmin,
  onSelectView,
  onSelectUser,
  onSelectChannel,
  onCreateChannel,
  onShowFingerprintModal,
  onOpenProfileDrawer,
  onToggleAdmin,
  onSelectAdminTab,
  onLogout,
  onOpenChannelSettings,
  onCloseDM,
  unreadDMs = {},
  unreadChannels = {},
  recentDMs = [],
  latestDMMessages = {},
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [activeDMPartners, setActiveDMPartners] = useState<string[]>([]);
  const [searchMode, setSearchMode] = useState(false);

  // Muted conversations
  const [mutedSet, setMutedSet] = useState<Set<string>>(new Set());

  // Hidden conversations
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(new Set());

  // Confirm dialog for closing DM
  const [closeConfirmUser, setCloseConfirmUser] = useState<User | null>(null);

  const otherUsers = users.filter(u => u.userId !== currentUser?.userId && u.statusMessage !== '[deleted]');
  const onlineCount = otherUsers.filter(u => u.isOnline).length;

  // Filter users based on mode
  const filteredUsers = (searchMode
    ? otherUsers.filter(u =>
        u.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (u.fullName || '').toLowerCase().includes(searchTerm.toLowerCase())
      )
    : (() => {
        // Merge recentDMs (instant) with activeDMPartners (Dexie-backed)
        const recentIds = new Set(recentDMs.map(u => u.userId));
        const dexieMatches = otherUsers.filter(u => activeDMPartners.includes(u.userId) && !recentIds.has(u.userId));
        // recentDMs first (already ordered by most recent), then Dexie matches
        return [...recentDMs.filter(u => otherUsers.some(o => o.userId === u.userId)), ...dexieMatches];
      })()
  );
  const visibleDMUsers = filteredUsers.filter(u => !hiddenSet.has(u.userId));
  const hiddenDMUsers = filteredUsers.filter(u => hiddenSet.has(u.userId));

  const filteredChannels = channels.filter(c =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Load active DM partners
  const loadActiveDMs = useCallback(async () => {
    if (!currentUser?.userId) return;
    const partners = await getActiveDMPartners(currentUser.userId);
    setActiveDMPartners(partners);
  }, [currentUser?.userId]);

  useEffect(() => {
    loadActiveDMs();
  }, [loadActiveDMs]);

  // Reload active DMs when messages change (listen to dexie changes)
  useEffect(() => {
    const observable = liveQuery(() => getActiveDMPartners(currentUser?.userId || ''));
    const subscription = observable.subscribe({
      next: (partners) => setActiveDMPartners(partners),
      error: (err) => console.error('[Sidebar] Live query error:', err),
    });
    return () => subscription.unsubscribe();
  }, [currentUser?.userId]);

  useEffect(() => {
    const load = async () => {
      const map: Record<string, string> = {};
      for (const u of users) {
        if (u.publicKey) map[u.userId] = await getFingerprint(u.publicKey);
      }
      setFingerprints(map);
    };
    load();
  }, [users]);

  useEffect(() => {
    getMutedConversations().then(setMutedSet);
  }, []);

  useEffect(() => {
    getHiddenConversations().then(setHiddenSet);
  }, []);

  const [muteMenuUser, setMuteMenuUser] = useState<{ userId: string; username: string } | null>(null);

  const MUTE_DURATIONS = [
    { label: '15 minutes', ms: 15 * 60 * 1000 },
    { label: '1 hour', ms: 60 * 60 * 1000 },
    { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
    { label: '12 hours', ms: 12 * 60 * 60 * 1000 },
    { label: '1 day', ms: 24 * 60 * 60 * 1000 },
    { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
    { label: 'Until I turn it back on', ms: undefined },
  ];

  const handleToggleMute = useCallback(async (conversationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (mutedSet.has(conversationId)) {
      await unmuteConversation(conversationId);
      setMutedSet(prev => { const next = new Set(prev); next.delete(conversationId); return next; });
    } else {
      // Show duration picker
      setMuteMenuUser({ userId: conversationId, username: '' });
    }
  }, [mutedSet]);

  const handleMuteWithDuration = async (durationMs?: number) => {
    if (!muteMenuUser) return;
    await muteConversation(muteMenuUser.userId, durationMs);
    setMutedSet(prev => new Set(prev).add(muteMenuUser.userId));
    setMuteMenuUser(null);
  };

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleSelectUserWrapper = (user: User) => {
    onSelectUser(user);
    if (isMobile) setIsCollapsed(true);
  };

  const handleSelectChannelWrapper = (channel: Channel) => {
    onSelectChannel(channel);
    if (isMobile) setIsCollapsed(true);
  };

  return (
    <aside
      className={`${
        isCollapsed ? 'w-16' : 'w-72'
      } flex flex-col h-full select-none flex-shrink-0 transition-all duration-300 relative z-20`}
      style={{ backgroundColor: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-color)' }}
    >
      {/* Top Header: Logo, Title & Collapse Toggle */}
      <div 
        className="h-16 px-4 flex items-center justify-between shrink-0"
        style={{ borderBottom: '1px solid var(--border-color)' }}
      >
        {!isCollapsed && (
          <div className="flex items-center space-x-2.5 overflow-hidden">
            <div
              title="PetroShield Enterprise E2EE"
              className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 cursor-pointer transition-smooth"
              style={{ 
                backgroundColor: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent)',
              }}
            >
              <ShieldCheck className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <div className="flex flex-col truncate">
              <span className="font-bold text-sm tracking-wide" style={{ color: 'var(--text-main)' }}>
                PetroShield
              </span>
              <span className="text-[9px] font-bold tracking-widest" style={{ color: '#34d399' }}>
                E2EE SECURE
              </span>
            </div>
          </div>
        )}

        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          className={`${isCollapsed ? 'w-10 h-10' : 'w-7 h-7'} rounded-lg flex items-center justify-center transition-smooth flex-shrink-0`}
          style={{ 
            backgroundColor: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-muted)'
          }}
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Primary Workspace Navigation Switcher (Tabs) */}
      <div className="p-2" style={{ borderBottom: '1px solid var(--border-color)' }}>
        {!isCollapsed ? (
          <div className="flex p-0.5 rounded-xl" style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)' }}>
            {[
              { view: 'dms' as const, icon: MessageSquare, label: 'DMs', unread: Object.values(unreadDMs).reduce((a, b) => a + b, 0) },
              { view: 'channels' as const, icon: Hash, label: 'Channels', unread: Object.values(unreadChannels).reduce((a, b) => a + b, 0) },
            ].map(({ view, icon: Icon, label, unread }) => (
              <button
                key={view}
                onClick={() => onSelectView(view)}
                className="flex-1 px-2 py-2.5 rounded-lg text-xs font-bold flex items-center justify-center space-x-1.5 transition-smooth relative"
                style={{
                  backgroundColor: activeView === view && !showAdmin ? 'var(--accent-primary)' : 'transparent',
                  color: activeView === view && !showAdmin ? 'var(--bg-surface)' : 'var(--text-muted)',
                  boxShadow: activeView === view && !showAdmin ? '0 2px 8px var(--glow-color)' : 'none'
                }}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
                {unread > 0 && activeView !== view && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-[8px] font-bold flex items-center justify-center"
                    style={{ backgroundColor: '#ef4444', color: '#fff' }}
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            ))}

            {isAdmin && (
              <button
                onClick={onToggleAdmin}
                className="flex-1 px-2 py-2.5 rounded-lg text-xs font-bold flex items-center justify-center space-x-1.5 transition-smooth"
                style={{
                  backgroundColor: showAdmin ? 'var(--accent-primary)' : 'transparent',
                  color: showAdmin ? 'var(--bg-surface)' : 'var(--text-muted)',
                  boxShadow: showAdmin ? '0 2px 8px var(--glow-color)' : 'none'
                }}
              >
                <Shield className="w-3.5 h-3.5" />
                <span>Admin</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col space-y-1.5 items-center">
            {[
              { view: 'dms' as const, icon: MessageSquare, title: 'Direct Messages', unread: Object.values(unreadDMs).reduce((a, b) => a + b, 0) },
              { view: 'channels' as const, icon: Hash, title: 'Channels', unread: Object.values(unreadChannels).reduce((a, b) => a + b, 0) },
            ].map(({ view, icon: Icon, title, unread }) => (
              <button
                key={view}
                onClick={() => onSelectView(view)}
                title={title}
                className="w-10 h-10 rounded-xl flex items-center justify-center transition-smooth relative"
                style={{
                  backgroundColor: activeView === view && !showAdmin ? 'var(--accent-primary)' : 'transparent',
                  color: activeView === view && !showAdmin ? 'var(--bg-surface)' : 'var(--text-muted)',
                  boxShadow: activeView === view && !showAdmin ? '0 2px 8px var(--glow-color)' : 'none'
                }}
              >
                <Icon className="w-5 h-5" />
                {unread > 0 && activeView !== view && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-0.5 rounded-full text-[7px] font-bold flex items-center justify-center"
                    style={{ backgroundColor: '#ef4444', color: '#fff' }}
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            ))}

            {isAdmin && (
              <button
                onClick={onToggleAdmin}
                title="Admin Dashboard"
                className="w-10 h-10 rounded-xl flex items-center justify-center transition-smooth"
                style={{
                  backgroundColor: showAdmin ? 'var(--accent-primary)' : 'transparent',
                  color: showAdmin ? 'var(--bg-surface)' : 'var(--text-muted)',
                  boxShadow: showAdmin ? '0 2px 8px var(--glow-color)' : 'none'
                }}
              >
                <UserCog className="w-5 h-5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* List Header & Search (Only when Expanded and not in admin mode) */}
      {!isCollapsed && !showAdmin && (
        <div className="p-3 space-y-2" style={{ borderBottom: '1px solid var(--border-color)' }}>
          <div className="flex items-center justify-between">
            <h2 className="text-[10px] font-bold tracking-wider flex items-center space-x-1.5" style={{ color: 'var(--text-muted)' }}>
              {activeView === 'channels' ? (
                <>
                  <Hash className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
                  <span>CHANNELS</span>
                </>
              ) : searchMode ? (
                <>
                  <UserPlus className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
                  <span>FIND PEOPLE</span>
                </>
              ) : (
                <>
                  <MessageSquare className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
                  <span>MESSAGES</span>
                </>
              )}
            </h2>

            {activeView === 'channels' ? (
              <button
                onClick={() => setModalOpen(true)}
                className="px-2 py-1 rounded-md text-[10px] font-bold flex items-center space-x-1 transition-smooth"
                style={{
                  backgroundColor: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)',
                  color: 'var(--accent-primary)'
                }}
              >
                <Plus className="w-3 h-3" />
                <span>NEW</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  setSearchMode(!searchMode);
                  setSearchTerm('');
                }}
                className="px-2 py-1 rounded-md text-[10px] font-bold flex items-center space-x-1 transition-smooth"
                style={{
                  backgroundColor: searchMode ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                  border: `1px solid ${searchMode ? 'color-mix(in srgb, var(--accent-primary) 35%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 30%, transparent)'}`,
                  color: 'var(--accent-primary)'
                }}
              >
                {searchMode ? (
                  <>
                    <X className="w-3 h-3" />
                    <span>CLOSE</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-3 h-3" />
                    <span>NEW DM</span>
                  </>
                )}
              </button>
            )}
          </div>

          <div className="relative">
            <input
              type="search"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={activeView === 'channels' ? 'Filter channels...' : searchMode ? 'Search people...' : 'Filter conversations...'}
              className="w-full rounded-lg pl-8 pr-3 py-2 text-xs focus:outline-none focus:ring-2 transition-smooth"
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-main)',
                '--tw-ring-color': 'var(--accent-primary)'
              } as React.CSSProperties}
            />
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
      )}

      {/* Content List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {showAdmin ? (
          /* Admin Tabs in content area */
          <>
            {[
              { tab: 'overview' as const, icon: Activity, label: 'Overview', desc: 'System health & stats' },
              { tab: 'users' as const, icon: Users, label: 'User Management', desc: 'Manage roles & accounts' },
              { tab: 'infrastructure' as const, icon: Server, label: 'Infrastructure', desc: 'Server & database' },
            ].map(({ tab, icon: Icon, label, desc }) => {
              const isActive = showAdmin && adminTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => onSelectAdminTab(tab)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center space-x-3 transition-smooth ${!isCollapsed ? '' : 'justify-center'}`}
                  style={{
                    backgroundColor: isActive ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : 'transparent',
                    border: isActive ? '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' : '1px solid transparent',
                  }}
                >
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: isActive ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'var(--bg-input)' }}>
                    <Icon className="w-4 h-4" style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                  </div>
                  {!isCollapsed && (
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate" style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-main)' }}>{label}</p>
                      <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{desc}</p>
                    </div>
                  )}
                </button>
              );
            })}
          </>
        ) : activeView === 'channels' ? (
          /* Channels List */
          filteredChannels.length === 0 ? (
            !isCollapsed && (
              <div className="p-6 text-center text-xs space-y-2 rounded-lg m-2" style={{ border: '1px dashed var(--border-color)', color: 'var(--text-muted)' }}>
                <Hash className="w-6 h-6 mx-auto opacity-40" />
                <p className="font-bold">NO CHANNELS FOUND</p>
              </div>
            )
          ) : (
            <>
              {/* Official Channels Section */}
              {filteredChannels.some(ch => ch.type === 'official' || ch.isAnnouncement) && (
                <div className="mb-2">
                  {!isCollapsed && (
                    <div className="px-2 py-1.5 text-[9px] font-bold tracking-widest flex items-center space-x-1.5" style={{ color: 'color-mix(in srgb, var(--accent-primary) 70%, transparent)' }}>
                      <Shield className="w-3 h-3" />
                      <span>OFFICIAL</span>
                    </div>
                  )}
                  {filteredChannels
                    .filter(ch => ch.type === 'official' || ch.isAnnouncement)
                    .map(channel => {
                      const isSelected = selectedChannel?.id === channel.id;
                      const canEditChannel = currentUser?.role === 'ADMIN' || channel.createdBy === currentUser?.userId;
                      const unread = unreadChannels[channel.id] || 0;
                      return (
                        <div
                          key={channel.id}
                          onClick={() => handleSelectChannelWrapper(channel)}
                          title={`#${channel.name}`}
                          role="button"
                          tabIndex={0}
                          onKeyDown={e => { if (e.key === 'Enter') handleSelectChannelWrapper(channel); }}
                          className="w-full text-left px-2 py-2 rounded-lg flex items-center justify-between group transition-smooth cursor-pointer"
                          style={{
                            backgroundColor: isSelected ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : unread > 0 ? 'color-mix(in srgb, var(--accent-primary) 5%, transparent)' : 'transparent',
                            border: isSelected ? `1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)` : '1px solid transparent'
                          }}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0">
                            <div 
                              className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs flex-shrink-0"
                              style={{ 
                                backgroundColor: unread > 0 ? 'color-mix(in srgb, var(--accent-primary) 15%, var(--bg-input))' : 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                                border: unread > 0 ? `1px solid color-mix(in srgb, var(--accent-primary) 40%, var(--border-color))` : 'none',
                                color: 'var(--accent-primary)'
                              }}
                            >
                              <Shield className="w-3.5 h-3.5" />
                            </div>
                            {!isCollapsed && (
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center space-x-1.5">
                                  <span className="font-semibold text-xs truncate" style={{ color: 'var(--text-main)', fontWeight: unread > 0 ? 700 : 500 }}>
                                    #{channel.name}
                                  </span>
                                </div>
                                <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  {channel.description || 'Official channel'}
                                </div>
                              </div>
                            )}
                          </div>
                          {!isCollapsed && unread > 0 && (
                            <span
                              className="flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center mr-1"
                              style={{ backgroundColor: 'var(--accent-primary)', color: 'var(--accent-text)' }}
                            >
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
                          {!isCollapsed && (
                            <button
                              onClick={(e) => handleToggleMute(channel.id, e)}
                              className="p-1 rounded-md opacity-0 group-hover:opacity-100 transition-smooth"
                              style={{ color: mutedSet.has(channel.id) ? '#ef4444' : 'var(--text-muted)' }}
                              title={mutedSet.has(channel.id) ? 'Unmute' : 'Mute'}
                            >
                              {mutedSet.has(channel.id) ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Groups Section */}
              {filteredChannels.some(ch => ch.type !== 'official' && !ch.isAnnouncement) && (
                <div>
                  {!isCollapsed && (
                    <div className="px-2 py-1.5 text-[9px] font-bold tracking-widest flex items-center space-x-1.5" style={{ color: 'var(--text-muted)' }}>
                      <Users className="w-3 h-3" />
                      <span>GROUPS</span>
                    </div>
                  )}
                  {filteredChannels
                    .filter(ch => ch.type !== 'official' && !ch.isAnnouncement)
                    .map(channel => {
                      const isSelected = selectedChannel?.id === channel.id;
                      const canEditChannel = currentUser?.role === 'ADMIN' || channel.createdBy === currentUser?.userId;
                      const unread = unreadChannels[channel.id] || 0;
                      return (
                        <div
                          key={channel.id}
                          onClick={() => handleSelectChannelWrapper(channel)}
                          title={`#${channel.name}`}
                          role="button"
                          tabIndex={0}
                          onKeyDown={e => { if (e.key === 'Enter') handleSelectChannelWrapper(channel); }}
                          className="w-full text-left px-2 py-2 rounded-lg flex items-center justify-between group transition-smooth cursor-pointer"
                          style={{
                            backgroundColor: isSelected ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : unread > 0 ? 'color-mix(in srgb, var(--accent-primary) 5%, transparent)' : 'transparent',
                            border: isSelected ? `1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)` : '1px solid transparent'
                          }}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0">
                            <div 
                              className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs flex-shrink-0"
                              style={{ 
                                backgroundColor: unread > 0 ? 'color-mix(in srgb, var(--accent-primary) 15%, var(--bg-input))' : 'var(--bg-input)',
                                border: `1px solid ${unread > 0 ? 'color-mix(in srgb, var(--accent-primary) 40%, var(--border-color))' : 'var(--border-color)'}`,
                                color: 'var(--accent-primary)'
                              }}
                            >
                              #
                            </div>
                            {!isCollapsed && (
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold text-xs truncate flex items-center space-x-1.5" style={{ color: 'var(--text-main)', fontWeight: unread > 0 ? 700 : 500 }}>
                                  <span>#{channel.name}</span>
                                  {channel.type === 'team' && (
                                    <span className="text-[8px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: 'color-mix(in srgb, #34d399 12%, transparent)', color: '#34d399', border: '1px solid color-mix(in srgb, #34d399 25%, transparent)' }}>
                                      TEAM
                                    </span>
                                  )}
                                  {channel.type === 'official' && (
                                    <span className="text-[8px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: 'color-mix(in srgb, #f87171 12%, transparent)', color: '#f87171', border: '1px solid color-mix(in srgb, #f87171 25%, transparent)' }}>
                                      OFFICIAL
                                    </span>
                                  )}
                                  {channel.type === 'private' && (
                                    <span className="text-[8px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent)' }}>
                                      PRIVATE
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  {channel.description || 'Group channel'}
                                </div>
                              </div>
                            )}
                          </div>
                          {!isCollapsed && unread > 0 && (
                            <span
                              className="flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center mr-1"
                              style={{ backgroundColor: 'var(--accent-primary)', color: 'var(--accent-text)' }}
                            >
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
                          {!isCollapsed && (
                            <button
                              onClick={(e) => handleToggleMute(channel.id, e)}
                              className="p-1 rounded-md opacity-0 group-hover:opacity-100 transition-smooth"
                              style={{ color: mutedSet.has(channel.id) ? '#ef4444' : 'var(--text-muted)' }}
                              title={mutedSet.has(channel.id) ? 'Unmute' : 'Mute'}
                            >
                              {mutedSet.has(channel.id) ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </>
          )
        ) : (
          /* DM Roster */
          filteredUsers.length === 0 ? (
            !isCollapsed && (
              <div className="p-6 text-center text-xs space-y-2 rounded-lg m-2" style={{ border: '1px dashed var(--border-color)', color: 'var(--text-muted)' }}>
                {searchMode ? (
                  <>
                    <UserPlus className="w-6 h-6 mx-auto opacity-40" />
                    <p className="font-bold">NO MATCHES FOUND</p>
                    <p className="text-[10px] opacity-60">Try a different search term</p>
                  </>
                ) : (
                  <>
                    <MessageCircle className="w-6 h-6 mx-auto opacity-40" />
                    <p className="font-bold">NO CONVERSATIONS YET</p>
                    <p className="text-[10px] opacity-60">Search for someone to start a DM</p>
                  </>
                )}
              </div>
            )
          ) : (
            <>
            {visibleDMUsers.map(user => {
              const isSelected = selectedUser?.userId === user.userId;
              const fp = fingerprints[user.userId] || '...';
              // Always look up live presence from the users prop, not from recentDMs which may be stale
              const liveUser = users.find(u => u.userId === user.userId) || user;
              const isOnline = liveUser.isOnline ?? false;
              const isAway = liveUser.isAway ?? false;
              const unread = unreadDMs[user.userId] || 0;

              return (
                <div
                  key={user.userId}
                  onClick={() => handleSelectUserWrapper(liveUser)}
                  title={`${liveUser.fullName || liveUser.username} (${liveUser.role})`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') handleSelectUserWrapper(liveUser); }}
                  className="w-full text-left px-2 py-2 rounded-lg flex items-center group transition-smooth cursor-pointer"
                  style={{
                    backgroundColor: isSelected
                      ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)'
                      : unread > 0
                        ? 'color-mix(in srgb, var(--accent-primary) 5%, transparent)'
                        : 'transparent',
                    border: isSelected
                      ? `1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)`
                      : '1px solid transparent',
                  }}
                >
                  <div className="flex items-center space-x-2.5 min-w-0 flex-1">
                    <div className="relative flex-shrink-0">
                      <div 
                        className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[10px]"
                        style={{ 
                          backgroundColor: unread > 0 ? 'color-mix(in srgb, var(--accent-primary) 15%, var(--bg-input))' : 'var(--bg-input)',
                          border: `1px solid ${unread > 0 ? 'color-mix(in srgb, var(--accent-primary) 40%, var(--border-color))' : 'var(--border-color)'}`,
                          color: 'var(--accent-primary)'
                        }}
                      >
                        {user.username.substring(0, 2).toUpperCase()}
                      </div>
                      {user.avatarUrl && (
                        <img
                          src={user.avatarUrl}
                          alt={user.username}
                          className="w-8 h-8 rounded-lg absolute inset-0 object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      )}
                      <span
                        className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
                        style={{ 
                          backgroundColor: isOnline ? (isAway ? '#f59e0b' : '#34d399') : 'var(--text-muted)',
                          border: '2px solid var(--bg-sidebar)',
                          boxShadow: isOnline ? (isAway ? '0 0 6px #f59e0b' : '0 0 6px #34d399') : 'none'
                        }}
                      />
                    </div>

                    {!isCollapsed && (
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center space-x-1.5">
                          <span className="font-semibold text-xs truncate" style={{ color: unread > 0 ? 'var(--text-main)' : 'var(--text-main)', fontWeight: unread > 0 ? 700 : 500 }}>
                            {user.fullName || user.username}
                          </span>
                        </div>
                        {latestDMMessages[user.userId] && (
                          <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{latestDMMessages[user.userId]}</p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-0.5 flex-shrink-0 ml-1">
                    {!isCollapsed && unread > 0 && (
                      <span
                        className="min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center"
                        style={{ backgroundColor: 'var(--accent-primary)', color: 'var(--accent-text)' }}
                      >
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                    {!isCollapsed && (
                      <button
                        onClick={(e) => handleToggleMute(user.userId, e)}
                        className="p-1 rounded-md opacity-0 group-hover:opacity-100 transition-smooth"
                        style={{ color: mutedSet.has(user.userId) ? '#ef4444' : 'var(--text-muted)' }}
                        title={mutedSet.has(user.userId) ? 'Unmute' : 'Mute'}
                      >
                        {mutedSet.has(user.userId) ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    {!isCollapsed && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setCloseConfirmUser(user); }}
                        className="p-1 rounded-md opacity-0 group-hover:opacity-100 transition-smooth"
                        style={{ color: 'var(--text-muted)' }}
                        title="Close chat"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {hiddenDMUsers.length > 0 && !searchMode && (
              <div className="mt-2 pt-2" style={{ borderTop: '1px dashed var(--border-color)' }}>
                {!isCollapsed && (
                  <p className="text-[9px] font-bold px-2 mb-1.5" style={{ color: 'var(--text-muted)' }}>HIDDEN</p>
                )}
                {hiddenDMUsers.map(user => {
                  const fp = fingerprints[user.userId] || '...';
                  const liveUser = users.find(u => u.userId === user.userId) || user;
                  const isOnline = liveUser.isOnline ?? false;
                  const isAway = liveUser.isAway ?? false;
                  return (
                    <div
                      key={`hidden-${user.userId}`}
                      onClick={() => handleSelectUserWrapper(liveUser)}
                      title={`${liveUser.fullName || liveUser.username} - Click to open, hover to unhide`}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter') handleSelectUserWrapper(liveUser); }}
                      className="w-full text-left px-2 py-2 rounded-lg flex items-center justify-between group transition-smooth cursor-pointer"
                      style={{ opacity: 0.5 }}
                    >
                      <div className="flex items-center space-x-2.5 min-w-0">
                        <div className="relative flex-shrink-0">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[10px]"
                            style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                            {user.avatarUrl ? null : user.username.substring(0, 2).toUpperCase()}
                          </div>
                          {user.avatarUrl && (
                            <img src={user.avatarUrl} alt={user.username} className="w-8 h-8 rounded-lg absolute inset-0 object-cover" style={{ opacity: 0.5 }}
                              onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                          )}
                        </div>
                        {!isCollapsed && (
                          <span className="font-semibold text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                            {user.fullName || user.username}
                          </span>
                        )}
                      </div>
                      {!isCollapsed && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            await unhideConversation(user.userId);
                            setHiddenSet(prev => { const next = new Set(prev); next.delete(user.userId); return next; });
                          }}
                          className="p-1 rounded-md opacity-0 group-hover:opacity-100 transition-smooth"
                          style={{ color: '#34d399' }}
                          title="Unhide chat"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </>
          )
        )}
      </div>

      {/* Bottom Footer: User Identity Profile Badge & Settings */}
      {currentUser && (
        <div className="p-2" style={{ borderTop: '1px solid var(--border-color)' }}>
          {!isCollapsed ? (
            <div
              onClick={onOpenProfileDrawer}
              title="Open Profile & Settings"
              className="flex items-center space-x-2.5 min-w-0 cursor-pointer rounded-xl p-2 transition-smooth"
              style={{ backgroundColor: 'var(--hover-color)' }}
            >
              <div className="relative w-8 h-8 flex-shrink-0">
                {currentUser.avatarUrl ? (
                  <img
                    src={currentUser.avatarUrl}
                    alt="avatar"
                    className="w-8 h-8 rounded-lg object-cover"
                    style={{ border: '1px solid var(--border-color)' }}
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : null}
                <div
                  className="w-8 h-8 rounded-lg items-center justify-center font-bold text-[10px] absolute inset-0"
                  style={{ 
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--accent-primary)',
                    display: currentUser.avatarUrl ? 'none' : 'flex'
                  }}
                >
                  {currentUser.username.substring(0, 2).toUpperCase()}
                </div>
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="text-xs font-bold truncate" style={{ color: 'var(--text-main)' }}>
                  {currentUser.username}
                </div>
                <div className="text-[9px] truncate flex items-center space-x-1" style={{ color: 'var(--text-muted)' }}>
                  <span className="font-bold" style={{ color: 'var(--accent-primary)' }}>{currentUser.role}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex justify-center">
              <div
                onClick={onOpenProfileDrawer}
                title={`${currentUser.username} (${currentUser.role})`}
                className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-[10px] cursor-pointer overflow-hidden"
                style={{ 
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--accent-primary)'
                }}
              >
                {currentUser.avatarUrl ? (
                  <img
                    src={currentUser.avatarUrl}
                    alt="avatar"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  currentUser.username.substring(0, 2).toUpperCase()
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Channel Modal */}
      <CreateChannelModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreateChannel={onCreateChannel}
        users={users}
        currentUser={currentUser ?? undefined}
      />

      {/* Close DM Confirmation */}
      {closeConfirmUser && (
        <div className="fixed inset-0 z-[99998] flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
          onClick={() => setCloseConfirmUser(null)}>
          <div className="w-full max-w-xs rounded-2xl p-5 animate-[scaleIn_0.15s_ease-out]"
            style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold mb-2" style={{ color: 'var(--text-main)' }}>Close Chat</h3>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              Hide {closeConfirmUser.fullName || closeConfirmUser.username} from your chat list? You can still find them in the user list.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setCloseConfirmUser(null)} className="flex-1 py-2 rounded-xl text-xs font-bold"
                style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>Cancel</button>
              <button onClick={async () => {
                await hideConversation(closeConfirmUser.userId);
                setHiddenSet(prev => new Set(prev).add(closeConfirmUser.userId));
                if (onCloseDM) onCloseDM(closeConfirmUser.userId);
                setCloseConfirmUser(null);
              }} className="flex-1 py-2 rounded-xl text-xs font-bold"
                style={{ backgroundColor: '#ef4444', color: '#fff' }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Mute Duration Picker */}
      {muteMenuUser && (
        <div className="fixed inset-0 z-[99998] flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
          onClick={() => setMuteMenuUser(null)}>
          <div className="w-full max-w-xs rounded-2xl p-5 animate-[scaleIn_0.15s_ease-out]"
            style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--text-main)' }}>Mute for...</h3>
            <div className="space-y-1">
              {MUTE_DURATIONS.map((dur) => (
                <button
                  key={dur.label}
                  onClick={() => handleMuteWithDuration(dur.ms)}
                  className="w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-smooth"
                  style={{ color: 'var(--text-main)' }}
                  onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--hover-color)'}
                  onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  {dur.label}
                </button>
              ))}
            </div>
            <button onClick={() => setMuteMenuUser(null)} className="w-full mt-3 py-2 rounded-xl text-xs font-bold"
              style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>Cancel</button>
          </div>
        </div>
      )}
    </aside>
  );
};
