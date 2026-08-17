import React, { useState, useEffect, useCallback, useRef } from 'react';
import { liveQuery } from 'dexie';
import { socket, connectSocket } from './lib/socket';
import { Loader2 } from 'lucide-react';
import { ConfirmModal } from './components/modals/ConfirmModal';
import { showToast, ToastContainer } from './lib/toast';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportKeyToJwk,
  importPrivateKeyFromJwk,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  getFingerprint,
  computePublicKeyFingerprint,
  generateChannelSymmetricKey,
  importSymmetricKeyFromJwk,
  decryptPrivateKeyVault,
  encryptKeyVaultPair,
  unwrapKeyVault,
  generateSigningKeyPair,
  encryptChannelKeyForUser,
  decryptChannelKeyForUser,
  compareFingerprints,
  encryptBinaryData,
  signKeyRotation,
  verifyKeyRotationSignature
} from './lib/crypto';
import {
  API_BASE,
  MAX_ATTACHMENT_BYTES,
  uploadEncryptedAttachment,
  readFileAsArrayBuffer,
  generateImageThumbnail
} from './lib/attachments';
import {
  db,
  saveUserKeyPair,
  getUserKeyPair,
  getAnyUserKeyPair,
  saveMessage,
  updateMessageStatus,
  bulkUpdateMessageStatus,
  editMessageLocally,
  deleteMessageLocally,
  markMessageDeletedLocally,
  getTrustedKey,
  saveTrustedKey,
  saveChannel,
  getStoredChannels,
  getPendingSyncMessages,
  saveChannelKey,
  getChannelKey,
  getActiveDMPartners,
  markForwarded
} from './lib/db';
import { useNetworkStatus, processOfflineQueue } from './lib/queue';
import { playNotificationSound } from './lib/notify';
import type {
  User,
  Channel,
  LocalMessage,
  EncryptedPayload,
  UserKeyPair,
  UserRole,
  AttachmentMeta,
  AttachmentPayload,
  PendingUpload
} from './types/chat';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';

// ── JWT Storage Helpers ────────────────────────────────────────────────────
function getJwtToken(): string | null {
  const token = localStorage.getItem('petroshield_jwt');
  if (token) return token;
  return sessionStorage.getItem('petroshield_jwt');
}
function isTokenExpired(): boolean {
  const token = getJwtToken();
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return Date.now() >= payload.exp;
  } catch {
    return true;
  }
}
function setJwtToken(token: string) {
  const stayLoggedIn = localStorage.getItem('petroshield_stayLoggedIn') !== 'false';
  if (stayLoggedIn) {
    localStorage.setItem('petroshield_jwt', token);
  } else {
    sessionStorage.setItem('petroshield_jwt', token);
  }
}
function removeJwtToken() {
  localStorage.removeItem('petroshield_jwt');
  sessionStorage.removeItem('petroshield_jwt');
}
import { AuthModal } from './components/AuthModal';
import { OfflineBanner } from './components/OfflineBanner';
import { ProfileDrawer } from './components/ProfileDrawer';
import { UserAvatarMenu } from './components/UserAvatarMenu';
import { ChannelSettingsModal } from './components/channels/ChannelSettingsModal';
import type { AdminUser } from './types/chat';

const AdminDashboard = React.lazy(() => import('./components/AdminDashboard').then(m => ({ default: m.AdminDashboard })));
const MessageSearch = React.lazy(() => import('./components/MessageSearch').then(m => ({ default: m.MessageSearch })));

export const App: React.FC = () => {
  // Block Ctrl+scroll zoom on entire app (lightbox handles its own zoom)
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      // Check if lightbox portal exists in DOM (rendered via createPortal into body)
      if (e.ctrlKey && !document.querySelector('[data-lightbox-open]')) {
        e.preventDefault();
      }
    };
    document.addEventListener('wheel', handler, { passive: false });
    return () => document.removeEventListener('wheel', handler);
  }, []);

  // ── Auth & Keys ──────────────────────────────────────────────────────────────
  const [currentUserKeys, setCurrentUserKeys] = useState<UserKeyPair | null>(null);
  const [privateKeyObject, setPrivateKeyObject] = useState<CryptoKey | null>(null);
  const [userFingerprint, setUserFingerprint] = useState<string>('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isRehydrating, setIsRehydrating] = useState(true);
  const [theme, setTheme] = useState<string>(() => {
    const guestSaved = localStorage.getItem('petroshield_theme_guest');
    if (guestSaved && guestSaved !== 'undefined') {
      document.documentElement.setAttribute('data-theme', guestSaved);
      return guestSaved;
    }
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const initial = prefersDark ? 'vault-dark' : 'clean-light';
    document.documentElement.setAttribute('data-theme', initial);
    localStorage.setItem('petroshield_theme_guest', initial);
    return initial;
  });
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminTab, setAdminTab] = useState<'overview' | 'users' | 'infrastructure'>('overview');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [showProfileDrawer, setShowProfileDrawer] = useState(false);
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [avatarMenu, setAvatarMenu] = useState<{ user: User; rect: DOMRect } | null>(null);
  const [channelSettings, setChannelSettings] = useState<Channel | null>(null);

  // Apply user-specific theme when logged in
  useEffect(() => {
    const userId = currentUserKeys?.userId;
    if (userId) {
      const saved = localStorage.getItem(`petroshield_theme_${userId}`);
      if (saved && saved !== 'undefined') {
        document.documentElement.setAttribute('data-theme', saved);
        setTheme(saved);
      }
    }
  }, [currentUserKeys?.userId]);

  // Persist theme changes
  useEffect(() => {
    const userId = currentUserKeys?.userId || 'guest';
    localStorage.setItem(`petroshield_theme_${userId}`, theme);
  }, [theme, currentUserKeys?.userId]);

  // ── Directory & Presence ─────────────────────────────────────────────────────
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const allUsersRef = useRef<User[]>([]);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [awayIds, setAwayIds] = useState<Set<string>>(new Set());

  // Keep allUsersRef synchronized with state
  useEffect(() => {
    allUsersRef.current = allUsers;
  }, [allUsers]);

  // ── Navigation & Workspace State ──────────────────────────────────────────────
  const [activeView, setActiveView] = useState<'channels' | 'dms'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('petroshield_activeView');
      if (saved === 'channels' || saved === 'dms') return saved;
    }
    return 'dms';
  });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<User | null>(null);
  const selectedPeerRef = useRef<User | null>(null);
  useEffect(() => { selectedPeerRef.current = selectedPeer; }, [selectedPeer]);

  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const selectedChannelRef = useRef<Channel | null>(null);
  useEffect(() => { selectedChannelRef.current = selectedChannel; }, [selectedChannel]);
  const channelsRef = useRef<Channel[]>([]);
  useEffect(() => { channelsRef.current = channels; }, [channels]);
  const [peerFingerprint, setPeerFingerprint] = useState<string>('');
  const [showFingerprintModal, setShowFingerprintModal] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({});
  const [showSearch, setShowSearch] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [unreadDMs, setUnreadDMs] = useState<Record<string, number>>({});
  const [lastViewedDms, setLastViewedDms] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('petroshield_lastViewedDms') || '{}'); } catch { return {}; }
  });
  const [unreadChannels, setUnreadChannels] = useState<Record<string, number>>({});
  const [lastViewedChannels, setLastViewedChannels] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('petroshield_lastViewedChannels') || '{}'); } catch { return {}; }
  });
  // Persist activeView (dms/channels) to localStorage
  useEffect(() => {
    localStorage.setItem('petroshield_activeView', activeView);
  }, [activeView]);
  const [latestDMMessages, setLatestDMMessages] = useState<Record<string, string>>({});
  const [pinnedMessages, setPinnedMessages] = useState<Record<string, { messageId: string; pinnedBy: string; pinnedAt: number }[]>>({});

  // ── Security & Caches ─────────────────────────────────────────────────────────
  const [mitmWarnings, setMitmWarnings] = useState<Record<string, boolean>>({});
  const [sharedKeysCache, setSharedKeysCache] = useState<Map<string, CryptoKey>>(new Map());
  const [channelKeysCache, setChannelKeysCache] = useState<Map<string, CryptoKey>>(new Map());

  // ── Network ──────────────────────────────────────────────────────────────────
  const networkStatus = useNetworkStatus(socket, currentUserKeys?.userId);
  const { isOffline, pendingCount } = networkStatus;
  const isFlushing = useRef(false);

  // ── Recent DMs (instant sidebar updates) ─────────────────────────────────────
  const [recentDMs, setRecentDMs] = useState<User[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // Load recent DM partners from IndexedDB on mount so sidebar order persists across refresh
  useEffect(() => {
    if (!currentUserKeys || allUsers.length === 0 || !historyLoaded) return;
    (async () => {
      const partnerIds = await getActiveDMPartners(currentUserKeys.userId);
      const ordered = partnerIds
        .map(id => allUsers.find(u => u.userId === id))
        .filter(Boolean) as User[];
      if (ordered.length > 0) {
        setRecentDMs(ordered.map(u => ({ ...u, isOnline: onlineIds.has(u.userId) })));
      }
    })();
  }, [currentUserKeys, allUsers.length, historyLoaded, onlineIds]);

  const upsertDMConversation = useCallback((peer: User, lastMessageText: string) => {
    setRecentDMs(prev => {
      const filtered = prev.filter(u => u.userId !== peer.userId);
      const updatedUser: User = {
        ...peer,
        isOnline: onlineIds.has(peer.userId),
      };
      return [updatedUser, ...filtered];
    });
  }, [onlineIds]);

  // ── On-Demand Public Key Fetch ───────────────────────────────────────────────
  const fetchUserPublicKey = useCallback(async (userId: string): Promise<string | null> => {
    const token = getJwtToken();
    if (!token) return null;
    try {
      const res = await fetch(`${API_BASE}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const data = await res.json();
      const freshUsers: User[] = data.users || [];
      setAllUsers(prev => {
        const merged = [...prev];
        for (const u of freshUsers) {
          const idx = merged.findIndex(m => m.userId === u.userId);
          if (idx >= 0) merged[idx] = { ...merged[idx], ...u };
          else merged.push(u);
        }
        return merged;
      });
      return freshUsers.find(u => u.userId === userId)?.publicKey || null;
    } catch {
      return null;
    }
  }, []);

  // ── Helpers: Derive Shared ECDH Key for DMs ──────────────────────────────────
  const getOrDeriveSharedKey = useCallback(
    async (peerUserId: string, peerPublicKeyBase64: string): Promise<CryptoKey | null> => {
      if (!privateKeyObject) return null;
      // Cache key by peerId + publicKey so key rotation invalidates the cache
      const cacheKey = `${peerUserId}:${peerPublicKeyBase64.slice(0, 16)}`;
      if (sharedKeysCache.has(cacheKey)) return sharedKeysCache.get(cacheKey)!;
      try {
        const peerPubKey = await importPublicKey(peerPublicKeyBase64);
        const derivedKey = await deriveSharedKey(privateKeyObject, peerPubKey);
        setSharedKeysCache(prev => new Map(prev).set(cacheKey, derivedKey));
        return derivedKey;
      } catch (err) {
        console.error('[E2EE] Failed to derive shared key:', err);
        return null;
      }
    },
    [privateKeyObject, sharedKeysCache]
  );

  // ── Helpers: Group Channel Key Fetch / Distribution ─────────────────────────
  const getOrGenerateChannelKey = useCallback(async (channelId: string): Promise<CryptoKey | null> => {
    if (channelKeysCache.has(channelId)) return channelKeysCache.get(channelId)!;
    try {
      // 1. Check local Dexie IndexedDB
      const stored = await getChannelKey(channelId);
      if (stored?.keyJwk) {
        const imported = await importSymmetricKeyFromJwk(stored.keyJwk);
        setChannelKeysCache(prev => new Map(prev).set(channelId, imported));
        return imported;
      }

      // 2. Fetch encrypted channel key envelope from server
      const token = getJwtToken();
      if (token && currentUserKeys) {
        const res = await fetch(`${API_BASE}/api/channels/${channelId}/key`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          const { encryptedChannelKey, iv } = data.key;
          // Try all possible encryptors: creator first, then all channel members
          const channel = channels.find(c => c.id === channelId);
          const candidateIds = channel
            ? [channel.createdBy, ...(channel.memberIds || [])].filter((v, i, a) => a.indexOf(v) === i)
            : // Channel info not loaded yet — try all known users as candidates
              allUsers.map(u => u.userId).filter((v, i, a) => a.indexOf(v) === i);
          // Also include self — allUsers excludes the requesting user (buildUserDirectory)
          if (!candidateIds.includes(currentUserKeys.userId)) {
            candidateIds.push(currentUserKeys.userId);
          }
          console.log(`[ChannelKey] Trying ${candidateIds.length} candidates for channel ${channelId}:`, candidateIds);
          for (const candidateId of candidateIds) {
            // Check allUsers first, then fall back to self (currentUserKeys)
            const candidateUser = candidateId === currentUserKeys.userId
              ? { userId: currentUserKeys.userId, publicKey: currentUserKeys.publicKeyBase64 }
              : allUsers.find(u => u.userId === candidateId);
            if (!candidateUser?.publicKey) {
              console.log(`[ChannelKey] Candidate ${candidateId}: no publicKey available`);
              continue;
            }
            try {
              const sharedKey = await getOrDeriveSharedKey(candidateId, candidateUser.publicKey);
              if (!sharedKey) {
                console.log(`[ChannelKey] Candidate ${candidateId}: sharedKey derivation returned null`);
                continue;
              }
              const keyJwk = await decryptChannelKeyForUser(encryptedChannelKey, iv, sharedKey);
              const imported = await importSymmetricKeyFromJwk(keyJwk);
              await saveChannelKey({ channelId, keyJwk });
              setChannelKeysCache(prev => new Map(prev).set(channelId, imported));
              console.log(`[ChannelKey] Successfully decrypted channel key for ${channelId} using candidate ${candidateId}`);
              return imported;
            } catch {
              // This candidate didn't encrypt this envelope, try next
            }
          }
          console.warn(`[ChannelKey] All ${candidateIds.length} candidates failed for channel ${channelId}`);
        } else if (res.status === 404) {
          // No key envelope exists for this user yet — the channel creator needs to distribute one.
          // Do NOT generate a new key here as it would create an incompatible key.
          console.warn(`[ChannelKey] No key envelope for channel ${channelId} — waiting for creator to distribute.`);
        }
      }

      // No key available — messages will show as undecryptable
      return null;
    } catch (e) {
      return null;
    }
  }, [channelKeysCache, channels, allUsers, currentUserKeys, getOrDeriveSharedKey]);

  // ── Helper: Decrypt an EncryptedPayload into a LocalMessage ─────────────────
  const decryptPayload = useCallback(async (payload: EncryptedPayload, usersSource?: User[]): Promise<LocalMessage> => {
    if (!currentUserKeys) {
      return {
        id: payload.id,
        tempId: payload.tempId,
        senderId: payload.senderId,
        recipientId: payload.recipientId,
        channelId: payload.channelId,
        text: '🔒 Unable to decrypt: missing own keys',
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        timestamp: payload.timestamp ?? Date.now(),
        status: (payload.status as LocalMessage['status']) || 'received',
        isDecrypted: false,
        isEdited: payload.isEdited,
        isDeleted: payload.isDeleted,
        replyTo: payload.replyTo,
        attachment: payload.attachment,
        attachmentMeta: undefined,
        decryptionError: 'Missing own keys',
      };
    }
    const directory = usersSource || allUsersRef.current;
    let key: CryptoKey | null = null;
    let decryptionError: string | undefined = undefined;

    if (payload.channelId) {
      key = await getOrGenerateChannelKey(payload.channelId);
    } else {
      const peerId = payload.senderId === currentUserKeys.userId ? payload.recipientId : payload.senderId;
      if (!peerId) {
        return {
          id: payload.id,
          tempId: payload.tempId,
          senderId: payload.senderId,
          recipientId: payload.recipientId,
          channelId: payload.channelId,
          text: '🔒 Unable to decrypt: missing peer ID',
          ciphertext: payload.ciphertext,
          iv: payload.iv,
          timestamp: payload.timestamp ?? Date.now(),
          status: (payload.status as LocalMessage['status']) || 'received',
          isDecrypted: false,
          isEdited: payload.isEdited,
          isDeleted: payload.isDeleted,
          replyTo: payload.replyTo,
          attachment: payload.attachment,
          attachmentMeta: undefined,
          decryptionError: 'Missing peer ID',
        };
      }
      let peerPublicKey = peerId === currentUserKeys.userId
        ? currentUserKeys.publicKeyBase64
        : directory.find(u => u.userId === peerId)?.publicKey;

      // Always fetch fresh public key from server for DMs to avoid stale keys
      if (peerId !== currentUserKeys.userId) {
        const fetched = await fetchUserPublicKey(peerId);
        if (fetched) peerPublicKey = fetched;
      }

      if (peerPublicKey) key = await getOrDeriveSharedKey(peerId, peerPublicKey);
      else if (peerId !== currentUserKeys.userId) {
        console.error(`[E2EE] Cannot decrypt: missing public key for ${peerId}`);
        decryptionError = `Missing public key for peer ${peerId}`;
      }
    }

    if (!key) {
      return {
        id: payload.id,
        tempId: payload.tempId,
        senderId: payload.senderId,
        recipientId: payload.recipientId,
        channelId: payload.channelId,
        text: '🔒 Unable to decrypt message',
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        timestamp: payload.timestamp ?? Date.now(),
        status: (payload.status as LocalMessage['status']) || 'received',
        isDecrypted: false,
        isEdited: payload.isEdited,
        isDeleted: payload.isDeleted,
        replyTo: payload.replyTo,
        attachment: payload.attachment,
        attachmentMeta: undefined,
        decryptionError: decryptionError ?? 'Unable to derive decryption key',
      };
    }

    let text = '🔒 Unable to decrypt message';
    let isDecrypted = false;
    if (payload.ciphertext) {
      try {
        text = await decryptMessage(payload.ciphertext, payload.iv, key);
        isDecrypted = true;
      } catch (e) {
        // Retry: clear cache, re-fetch fresh pubkey, re-derive shared key
        if (!payload.channelId && payload.senderId !== currentUserKeys.userId) {
          try {
            setSharedKeysCache(prev => {
              const next = new Map(prev);
              for (const k of next.keys()) {
                if (k.startsWith(`${payload.senderId}:`) || k.startsWith(`${payload.recipientId}:`)) next.delete(k);
              }
              return next;
            });
            const freshPubKey = await fetchUserPublicKey(payload.senderId);
            if (freshPubKey && privateKeyObject) {
              const peerPubKey = await importPublicKey(freshPubKey);
              const freshKey = await deriveSharedKey(privateKeyObject, peerPubKey);
              text = await decryptMessage(payload.ciphertext, payload.iv, freshKey);
              isDecrypted = true;
              console.log('[E2EE] Decryption succeeded on retry with fresh key');
            }
          } catch (retryErr) {
            console.error('[E2EE] Decrypt retry also failed:', retryErr);
            decryptionError = 'Decryption failed (key mismatch)';
          }
        } else {
          console.error('[E2EE] Decrypt error:', e);
          decryptionError = 'Decryption failed';
        }
      }
    } else {
      text = '';
      isDecrypted = true; // attachment-only message
    }

    let attachmentMeta: AttachmentMeta | undefined;
    if (payload.attachment?.encryptedMetadata) {
      try {
        const metaJson = await decryptMessage(payload.attachment.encryptedMetadata, payload.attachment.iv, key);
        attachmentMeta = JSON.parse(metaJson);
      } catch (e) {
        console.error('[E2EE] Attachment metadata decrypt error:', e);
        attachmentMeta = undefined;
      }
    }

    return {
      id: payload.id,
      tempId: payload.tempId,
      senderId: payload.senderId,
      recipientId: payload.recipientId,
      channelId: payload.channelId,
      text,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      timestamp: payload.timestamp ?? Date.now(),
      status: (payload.status as LocalMessage['status']) || 'received',
      isDecrypted,
      isEdited: payload.isEdited,
      isDeleted: payload.isDeleted,
      replyTo: payload.replyTo,
      attachment: payload.attachment,
      attachmentMeta,
      decryptionError,
    };
  }, [currentUserKeys, getOrDeriveSharedKey, getOrGenerateChannelKey, fetchUserPublicKey]);

  // ── Helper: Resolve the AES-GCM key for a stored local message (for attachments)
  const resolveMessageKey = useCallback(async (msg: LocalMessage): Promise<CryptoKey | null> => {
    if (!currentUserKeys || !privateKeyObject) return null;
    if (msg.channelId) return await getOrGenerateChannelKey(msg.channelId);
    const peerId = msg.senderId === currentUserKeys.userId ? msg.recipientId : msg.senderId;
    if (!peerId) return null;
    const peer = allUsersRef.current.find(u => u.userId === peerId);
    if (!peer?.publicKey) return null;
    return await getOrDeriveSharedKey(peerId, peer.publicKey);
  }, [currentUserKeys, privateKeyObject, getOrDeriveSharedKey, getOrGenerateChannelKey]);

  // ── Full History Rehydration (GET /api/messages) ────────────────────────────
  const fetchAllHistory = useCallback(async (token: string) => {
    if (!currentUserKeys) return;
    try {
      // Fetch the directory fresh so decryption doesn't depend on UI state timing
      let usersSource: User[] = allUsersRef.current;
      try {
        const usersRes = await fetch(`${API_BASE}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          usersSource = usersData.users || [];
          // Merge presence from HTTP response instead of replacing
          setOnlineIds(prev => {
            const next = new Set(prev);
            for (const u of usersSource) {
              if (u.isOnline) next.add(u.userId);
            }
            return next;
          });
        }
      } catch { /* keep existing directory */ }

      const res = await fetch(`${API_BASE}/api/messages`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      const payloads: EncryptedPayload[] = data.messages || [];
      const incoming: EncryptedPayload[] = [];
      for (const payload of payloads) {
        const local = await decryptPayload(payload, usersSource);
        if (local) {
          await saveMessage(local);
          if (payload.senderId !== currentUserKeys.userId) incoming.push(payload);
        }
      }
      // Notify senders that their offline messages reached our device
      // Skip messages already delivered (prevents receipt spam on every refresh)
      for (const payload of incoming) {
        const localMsg = await db.messages.get(payload.id);
        if (localMsg?.status === 'delivered' || localMsg?.status === 'read') continue;
        socket.emit('message:delivered', { messageId: payload.id, senderId: payload.senderId });
      }
      // Load reactions for all fetched messages
      console.log(`[History] Restored ${payloads.length} message(s) from PostgreSQL`);

      // Clean up undecryptable messages from Dexie and request server cleanup
      try {
        const undecryptable = await db.messages
          .where('isDecrypted').equals(0)
          .and(m => !!m.decryptionError || (m.text?.startsWith('🔒') ?? false))
          .toArray();
        if (undecryptable.length > 0) {
          const ids = undecryptable.map(m => m.id);
          await db.messages.bulkDelete(ids);
          console.log(`[Cleanup] Removed ${ids.length} undecryptable message(s) from local store`);
          // Request server cleanup (best-effort)
          fetch(`${API_BASE}/api/messages/cleanup`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          }).catch(() => {});
        }
      } catch (e) {
        console.error('[Cleanup] Failed to clean up undecryptable messages:', e);
      }
    } catch (e) {
      console.error('[History] Global history fetch error:', e);
    }
    setHistoryLoaded(true);
  }, [currentUserKeys, decryptPayload]);

  // ── Proactive Channel Key Distribution ──────────────────────────────────────
  // When we come online with a channel key, distribute it to members who don't have an envelope
  useEffect(() => {
    if (!historyLoaded || !currentUserKeys || !privateKeyObject) return;
    const distributeMissingKeys = async () => {
      const token = getJwtToken();
      if (!token) return;
      for (const ch of channels) {
        if (ch.type !== 'official') continue;
        const myKey = channelKeysCache.get(ch.id);
        if (!myKey) continue;
        try {
          const res = await fetch(`${API_BASE}/api/channels/${ch.id}/missing-keys`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (!res.ok) continue;
          const { members: missingIds } = await res.json();
          if (!missingIds || missingIds.length === 0) continue;
          const exportedKey = await crypto.subtle.exportKey('jwk', myKey);
          const keyEnvelopes: { userId: string; encryptedChannelKey: string; iv: string }[] = [];
          for (const memberId of missingIds) {
            if (memberId === currentUserKeys.userId) continue;
            const member = allUsersRef.current.find(u => u.userId === memberId);
            if (!member?.publicKey) continue;
            try {
              const sharedKey = await getOrDeriveSharedKey(memberId, member.publicKey);
              if (!sharedKey) continue;
              const env = await encryptChannelKeyForUser(exportedKey, sharedKey);
              keyEnvelopes.push({ userId: memberId, encryptedChannelKey: env.encryptedKey, iv: env.iv });
            } catch { /* skip */ }
          }
          if (keyEnvelopes.length > 0) {
            await fetch(`${API_BASE}/api/channels/${ch.id}/keys`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ keys: keyEnvelopes }),
            });
            console.log(`[ChannelKey] Proactively distributed key for ${ch.id} to ${keyEnvelopes.length} member(s)`);
          }
        } catch { /* best-effort */ }
      }
    };
    distributeMissingKeys();
  }, [historyLoaded, channels, channelKeysCache, currentUserKeys, privateKeyObject, getOrDeriveSharedKey]);

  // ── TOFU Key Pinning & Signed Rotation Chain Verification ────────────────────
  const validatePeerKeyTofu = useCallback(async (peer: User): Promise<boolean> => {
    try {
      const currentFp = await computePublicKeyFingerprint(peer.publicKey);
      const trusted = await getTrustedKey(peer.userId);
      if (!trusted) {
        await saveTrustedKey({
          peerUserId: peer.userId,
          fingerprint: currentFp,
          publicKey: peer.publicKey,
          keyVersion: peer.keyVersion ?? 1,
          firstSeenAt: Date.now(),
          lastValidatedAt: Date.now(),
        });
        setMitmWarnings(prev => ({ ...prev, [peer.userId]: false }));
        return true;
      }
      const matches = compareFingerprints(trusted.fingerprint, currentFp);
      if (matches) {
        setMitmWarnings(prev => ({ ...prev, [peer.userId]: false }));
        return true;
      }

      // Key changed → this is only legitimate if the rotation is cryptographically
      // signed by the OLD signing private key (verified against the pinned chain).
      const oldKey = peer.oldPublicKey;
      const oldSigningKey = peer.oldSigningPublicKey;
      const newSigningKey = peer.signingPublicKey;
      const rotationSig = peer.keyRotationSignature;
      const rotated = (peer.keyVersion ?? 1) > (trusted.keyVersion ?? 1)
        && !!oldKey && !!oldSigningKey && !!newSigningKey && !!rotationSig
        && compareFingerprints(await computePublicKeyFingerprint(oldKey), trusted.fingerprint);
      if (rotated) {
        const valid = await verifyKeyRotationSignature(peer.publicKey, newSigningKey, oldKey, rotationSig, oldSigningKey);
        if (valid) {
          await saveTrustedKey({
            peerUserId: peer.userId,
            fingerprint: currentFp,
            publicKey: peer.publicKey,
            keyVersion: peer.keyVersion ?? 1,
            firstSeenAt: trusted.firstSeenAt,
            lastValidatedAt: Date.now(),
          });
          setMitmWarnings(prev => ({ ...prev, [peer.userId]: false }));
          console.log(`[TOFU] Accepted signed key rotation for ${peer.username} (v${peer.keyVersion})`);
          return true;
        }
      }
      setMitmWarnings(prev => ({ ...prev, [peer.userId]: true }));
      return false;
    } catch (e) {
      console.error('[TOFU] Validation error — blocking by default:', e);
      setMitmWarnings(prev => ({ ...prev, [peer.userId]: true }));
      return false;
    }
  }, []);

  const handleTrustNewKey = async (peer: User) => {
    const currentFp = await computePublicKeyFingerprint(peer.publicKey);
    await saveTrustedKey({
      peerUserId: peer.userId,
      fingerprint: currentFp,
      publicKey: peer.publicKey,
      keyVersion: peer.keyVersion ?? 1,
      firstSeenAt: Date.now(),
      lastValidatedAt: Date.now(),
    });
    setMitmWarnings(prev => ({ ...prev, [peer.userId]: false }));
    const fp = await getFingerprint(peer.publicKey);
    setPeerFingerprint(fp);
    console.log(`[TOFU] Trusted & pinned new key fingerprint for ${peer.username}`);

    // Clear stale shared key cache entries for this peer so next derivation uses fresh keys
    setSharedKeysCache(prev => {
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (key.startsWith(`${peer.userId}:`)) next.delete(key);
      }
      return next;
    });

    // Re-fetch the peer's public key from server to ensure we have the latest
    const freshPubKey = await fetchUserPublicKey(peer.userId);
    if (freshPubKey && privateKeyObject) {
      try {
        const peerPubKey = await importPublicKey(freshPubKey);
        const freshSharedKey = await deriveSharedKey(privateKeyObject, peerPubKey);
        setSharedKeysCache(prev => new Map(prev).set(`${peer.userId}:${freshPubKey.slice(0, 16)}`, freshSharedKey));
      } catch (e) {
        console.error('[TOFU] Failed to re-derive shared key after trust:', e);
      }
    }

    // Re-decrypt any undecrypted DM messages from this peer
    try {
      const undecrypted = await db.messages
        .where('senderId').equals(peer.userId)
        .and(m => !m.isDecrypted && !!m.ciphertext && !m.channelId)
        .toArray();
      for (const msg of undecrypted) {
        const payload: EncryptedPayload = {
          id: msg.id, tempId: msg.tempId, senderId: msg.senderId,
          recipientId: msg.recipientId, ciphertext: msg.ciphertext!,
          iv: msg.iv!, timestamp: msg.timestamp, status: msg.status,
        };
        const decrypted = await decryptPayloadRef.current(payload);
        if (decrypted.isDecrypted) {
          await saveMessage(decrypted);
          console.log(`[TOFU] Re-decrypted message ${msg.id} from ${peer.username}`);
        }
      }
      // Also re-decrypt messages where THIS user is the sender (peer's incoming messages we sent)
      const undecryptedSelf = await db.messages
        .where('recipientId').equals(peer.userId)
        .and(m => !m.isDecrypted && !!m.ciphertext && !m.channelId)
        .toArray();
      for (const msg of undecryptedSelf) {
        const payload: EncryptedPayload = {
          id: msg.id, tempId: msg.tempId, senderId: msg.senderId,
          recipientId: msg.recipientId, ciphertext: msg.ciphertext!,
          iv: msg.iv!, timestamp: msg.timestamp, status: msg.status,
        };
        const decrypted = await decryptPayloadRef.current(payload);
        if (decrypted.isDecrypted) {
          await saveMessage(decrypted);
          console.log(`[TOFU] Re-decrypted outgoing message ${msg.id} to ${peer.username}`);
        }
      }
    } catch (e) {
      console.error('[TOFU] Failed to re-decrypt messages:', e);
    }
  };

  // ── Signed Key Rotation (device compromise / vault resync) ───────────────────
  const handleRotateKey = useCallback(async (password: string): Promise<void> => {
    if (!currentUserKeys || !privateKeyObject) return;
    try {
      const oldPublicKey = currentUserKeys.publicKeyBase64;
      const rawPair = await generateKeyPair();
      const newPublicKey = await exportPublicKey(rawPair.publicKey);
      const newPrivJwk = await exportKeyToJwk(rawPair.privateKey);
      const newPubJwk = await exportKeyToJwk(rawPair.publicKey);

      const signPair = await generateSigningKeyPair();
      const newSignPub = await exportPublicKey(signPair.publicKey);
      const newSignPrivJwk = await exportKeyToJwk(signPair.privateKey);
      const newSignPubJwk = await exportKeyToJwk(signPair.publicKey);

      const signature = await signKeyRotation(
        newPublicKey, newSignPub, oldPublicKey,
        currentUserKeys.privateSigningKeyJwk as JsonWebKey
      );
      const vault = await encryptKeyVaultPair(newPrivJwk, newSignPrivJwk, password);

      const token = getJwtToken();
      const res = await fetch(`${API_BASE}/api/auth/rotate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          publicKey: newPublicKey,
          signingPublicKey: newSignPub,
          encryptedPrivateKey: vault.encryptedPrivateKey,
          keySalt: vault.keySalt,
          signature,
          oldPublicKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Key rotation failed');

      const keyPair: UserKeyPair = {
        ...currentUserKeys,
        publicKeyBase64: newPublicKey,
        privateKeyJwk: newPrivJwk,
        publicKeyJwk: newPubJwk,
        signingPublicKeyBase64: newSignPub,
        privateSigningKeyJwk: newSignPrivJwk,
        publicSigningKeyJwk: newSignPubJwk,
        keyVersion: data.keyVersion ?? currentUserKeys.keyVersion,
      };
      await saveUserKeyPair(keyPair);
      const privKey = await importPrivateKeyFromJwk(newPrivJwk);
      setCurrentUserKeys(keyPair);
      setPrivateKeyObject(privKey);
      const fp = await getFingerprint(newPublicKey);
      setUserFingerprint(fp);
      if (socket.connected) {
        socket.emit('user:join', {
          userId: keyPair.userId, username: keyPair.username,
          fullName: keyPair.fullName, role: keyPair.role,
          publicKey: newPublicKey, signingPublicKey: newSignPub,
        });
      }
      console.log(`[KeyRotation] Rotated identity key → ${fp} (server v${data.keyVersion})`);
      showToast(`Identity key rotated. New fingerprint: ${fp}`, 'success');
    } catch (e: any) {
      console.error('[KeyRotation] Failed:', e?.message || 'unknown');
      showToast(`Key rotation failed: ${e?.message || 'unknown error'}`, 'error');
    }
  }, [currentUserKeys, privateKeyObject]);

  // ── Profile Update ────────────────────────────────────────────────────────────
  const handleUpdateProfile = useCallback(async (data: { fullName?: string; email?: string; avatar?: string; username?: string; statusMessage?: string; phone?: string }) => {
    if (!currentUserKeys) return;
    const token = getJwtToken();
    try {
      const res = await fetch(`${API_BASE}/api/auth/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Profile update failed');
      setCurrentUserKeys(prev => {
        if (!prev) return prev;
        const updated = { ...prev };
        if (data.fullName) updated.fullName = data.fullName;
        if (data.email) updated.email = data.email;
        if (data.avatar) updated.avatarUrl = result.user?.avatarUrl ?? data.avatar;
        if (data.username) updated.username = data.username;
        if (data.statusMessage !== undefined) updated.statusMessage = data.statusMessage;
        if (data.phone !== undefined) updated.phone = data.phone;
        saveUserKeyPair(updated).catch(() => {});
        return updated;
      });
      if (data.fullName && socket.connected) {
        socket.emit('user:join', {
          userId: currentUserKeys.userId, username: currentUserKeys.username,
          fullName: data.fullName, role: currentUserKeys.role,
          publicKey: currentUserKeys.publicKeyBase64,
          signingPublicKey: currentUserKeys.signingPublicKeyBase64,
        });
      }
      return result;
    } catch (e: any) {
      console.error('[Profile] Update failed:', e);
      throw e;
    }
  }, [currentUserKeys]);

  // ── Fetch User Directory ──────────────────────────────────────────────────────
  const fetchUserDirectory = useCallback(async (token: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      setAllUsers(data.users || []);
      const onlineSet = new Set<string>((data.users || []).filter((u: User) => u.isOnline).map((u: User) => u.userId));
      setOnlineIds(onlineSet);
    } catch (e) {
      console.error('[Directory] Failed to fetch user directory:', e);
    }
  }, []);

  // ── Session Rehydration on Page Refresh ──────────────────────────────────────
  useEffect(() => {
    const rehydrate = async () => {
      const token = getJwtToken();
      if (!token) { setIsRehydrating(false); return; }
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (res.ok && data.user) {
          let keyPair = await getUserKeyPair(data.user.userId) || await getAnyUserKeyPair();
          if (keyPair) {
            const privKey = await importPrivateKeyFromJwk(keyPair.privateKeyJwk);
            const fp = await getFingerprint(keyPair.publicKeyBase64);
            // Merge server-side profile data (avatar, fullName, email, status) into the keypair
            const enrichedKeyPair: UserKeyPair = {
              ...keyPair,
              fullName: data.user.fullName || keyPair.fullName,
              email: data.user.email || keyPair.email,
              avatarUrl: data.user.avatarUrl || keyPair.avatarUrl,
              statusMessage: data.user.statusMessage || keyPair.statusMessage,
              phone: data.user.phone || keyPair.phone,
              keyVersion: data.user.keyVersion ?? keyPair.keyVersion ?? 1,
            };
            setPrivateKeyObject(privKey);
            setCurrentUserKeys(enrichedKeyPair);
            setUserFingerprint(fp);
            setShowProfileDrawer(false);
            if (!socket.connected) connectSocket();
            socket.emit('user:join', {
              userId: enrichedKeyPair.userId, username: enrichedKeyPair.username,
              fullName: enrichedKeyPair.fullName, role: enrichedKeyPair.role,
              publicKey: enrichedKeyPair.publicKeyBase64,
              signingPublicKey: enrichedKeyPair.signingPublicKeyBase64
            });
            await fetchUserDirectory(token);
            socket.emit('channels:get');
            console.log(`[Rehydration] Session restored for ${enrichedKeyPair.username}`);
          }
        } else {
          removeJwtToken();
        }
      } catch (e) {
        console.error('[Rehydration] Error:', e);
      } finally {
        setIsRehydrating(false);
      }
    };
    rehydrate();
  }, [fetchUserDirectory]);

  // Restore full chat history from PostgreSQL once the session is established.
  // Runs after login AND after a server restart + browser refresh.
  useEffect(() => {
    if (currentUserKeys && !historyFetchedRef.current) {
      historyFetchedRef.current = true;
      const token = getJwtToken();
      if (token) fetchAllHistory(token);
    }
  }, [currentUserKeys, fetchAllHistory]);

  // ── Authentication ────────────────────────────────────────────────────────────
  const handleAuthenticate = async (params: {
    username: string; fullName?: string; email?: string;
    password: string; role: UserRole; isRegister: boolean;
  }) => {
    setAuthError(null);
    const { username, fullName, email, password, role, isRegister } = params;
    const userId = `usr_${username.trim().replace(/[^a-zA-Z0-9]/g, '')}`;

    let keyPair = await getUserKeyPair(userId);
    let privKey: CryptoKey;
    let pubKeyBase64: string;

    if (isRegister) {
      const rawPair = await generateKeyPair();
      pubKeyBase64 = await exportPublicKey(rawPair.publicKey);
      const privJwk = await exportKeyToJwk(rawPair.privateKey);
      const pubJwk  = await exportKeyToJwk(rawPair.publicKey);
      const signPair = await generateSigningKeyPair();
      const signPub = await exportPublicKey(signPair.publicKey);
      const signPrivJwk = await exportKeyToJwk(signPair.privateKey);
      const signPubJwk = await exportKeyToJwk(signPair.publicKey);
      const vault = await encryptKeyVaultPair(privJwk, signPrivJwk, password);

      keyPair = {
        userId, username: username.trim(),
        fullName: fullName || username.trim(),
        email: email || `${username.toLowerCase()}@petroshield.internal`,
        role, publicKeyBase64: pubKeyBase64,
        privateKeyJwk: privJwk, publicKeyJwk: pubJwk,
        signingPublicKeyBase64: signPub,
        privateSigningKeyJwk: signPrivJwk,
        publicSigningKeyJwk: signPubJwk,
        createdAt: Date.now()
      };
      await saveUserKeyPair(keyPair);
      privKey = rawPair.privateKey;

      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, fullName, email, password, role,
          publicKey: pubKeyBase64,
          signingPublicKey: signPub,
          encryptedPrivateKey: vault.encryptedPrivateKey,
          keySalt: vault.keySalt
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      setJwtToken(data.token);
      const fp = await getFingerprint(pubKeyBase64);
      setPrivateKeyObject(privKey);
      const registeredKeyPair: UserKeyPair = {
        ...keyPair,
        fullName: data.user.fullName || keyPair.fullName,
        email: data.user.email || keyPair.email,
        avatarUrl: data.user.avatarUrl || keyPair.avatarUrl,
        statusMessage: data.user.statusMessage || keyPair.statusMessage,
      };
      await saveUserKeyPair(registeredKeyPair);
      setCurrentUserKeys(registeredKeyPair);
      setUserFingerprint(fp);
      setShowProfileDrawer(false);

      if (!socket.connected) connectSocket();
      socket.emit('user:join', { userId: registeredKeyPair.userId, username: registeredKeyPair.username, fullName: data.user.fullName, role: registeredKeyPair.role, publicKey: pubKeyBase64, signingPublicKey: registeredKeyPair.signingPublicKeyBase64 });
      await fetchUserDirectory(data.token);
      socket.emit('channels:get');
    } else {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      const serverUser = data.user;

      // Ensure the local keypair always carries a signing key. If a legacy
      // pair (pre-signing-keys) or the vault predates them, generate one,
      // re-wrap the vault and sync it so future rotations are possible.
      const ensureSigningKeys = async (kp: UserKeyPair): Promise<UserKeyPair> => {
        if (kp.signingPublicKeyBase64 && kp.privateSigningKeyJwk && kp.publicSigningKeyJwk) return kp;
        const signPair = await generateSigningKeyPair();
        const signPub = await exportPublicKey(signPair.publicKey);
        const signPrivJwk = await exportKeyToJwk(signPair.privateKey);
        const signPubJwk = await exportKeyToJwk(signPair.publicKey);
        const vault = await encryptKeyVaultPair(kp.privateKeyJwk, signPrivJwk, password);
        const updated: UserKeyPair = {
          ...kp,
          signingPublicKeyBase64: signPub,
          privateSigningKeyJwk: signPrivJwk,
          publicSigningKeyJwk: signPubJwk,
        };
        await saveUserKeyPair(updated);
        await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username, password,
            publicKey: kp.publicKeyBase64,
            signingPublicKey: signPub,
            encryptedPrivateKey: vault.encryptedPrivateKey,
            keySalt: vault.keySalt,
            forceKeyRotation: true
          })
        });
        return updated;
      };

      if (keyPair && keyPair.publicKeyBase64 === serverUser.publicKey) {
        keyPair = await ensureSigningKeys(keyPair);
        privKey = await importPrivateKeyFromJwk(keyPair.privateKeyJwk);
        pubKeyBase64 = keyPair.publicKeyBase64;
      } else if (serverUser.encryptedPrivateKey && serverUser.keySalt) {
        try {
          const decrypted = await decryptPrivateKeyVault(
            serverUser.encryptedPrivateKey,
            serverUser.keySalt,
            password
          );
          const { ecdh, ecdsa } = unwrapKeyVault(decrypted);
          privKey = await importPrivateKeyFromJwk(ecdh);
          pubKeyBase64 = serverUser.publicKey;

          keyPair = {
            userId, username: serverUser.username,
            fullName: serverUser.fullName, email: serverUser.email,
            role: serverUser.role, publicKeyBase64: pubKeyBase64,
            privateKeyJwk: ecdh, publicKeyJwk: {} as JsonWebKey,
            signingPublicKeyBase64: serverUser.signingPublicKey,
            createdAt: Date.now()
          };
          if (ecdsa) {
            keyPair.privateSigningKeyJwk = ecdsa;
          }
          keyPair = await ensureSigningKeys(keyPair);
          await saveUserKeyPair(keyPair);
          console.log(`[KeyVault] Successfully synchronized key pair from vault!`);
        } catch (e) {
          console.error('[KeyVault] Failed to decrypt private key vault');
          throw new Error('Key Vault decryption failed. Check password.');
        }
      } else {
        const rawPair = await generateKeyPair();
        pubKeyBase64 = await exportPublicKey(rawPair.publicKey);
        const privJwk = await exportKeyToJwk(rawPair.privateKey);
        const pubJwk  = await exportKeyToJwk(rawPair.publicKey);
        const signPair = await generateSigningKeyPair();
        const signPub = await exportPublicKey(signPair.publicKey);
        const signPrivJwk = await exportKeyToJwk(signPair.privateKey);
        const signPubJwk = await exportKeyToJwk(signPair.publicKey);
        const vault = await encryptKeyVaultPair(privJwk, signPrivJwk, password);

        keyPair = {
          userId, username: username.trim(),
          fullName: serverUser.fullName || username.trim(),
          email: serverUser.email || `${username.toLowerCase()}@petroshield.internal`,
          role: serverUser.role || role,
          publicKeyBase64: pubKeyBase64,
          privateKeyJwk: privJwk, publicKeyJwk: pubJwk,
          signingPublicKeyBase64: signPub,
          privateSigningKeyJwk: signPrivJwk,
          publicSigningKeyJwk: signPubJwk,
          createdAt: Date.now()
        };
        await saveUserKeyPair(keyPair);
        privKey = rawPair.privateKey;

        await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username, password,
            publicKey: pubKeyBase64,
            signingPublicKey: signPub,
            encryptedPrivateKey: vault.encryptedPrivateKey,
            keySalt: vault.keySalt,
            forceKeyRotation: true
          })
        });
      }

      setJwtToken(data.token);
      const fp = await getFingerprint(pubKeyBase64);
      setPrivateKeyObject(privKey);
      const enrichedKeyPair: UserKeyPair = {
        ...keyPair,
        fullName: serverUser.fullName || keyPair.fullName,
        email: serverUser.email || keyPair.email,
        avatarUrl: serverUser.avatarUrl || keyPair.avatarUrl,
        statusMessage: serverUser.statusMessage || keyPair.statusMessage,
        keyVersion: serverUser.keyVersion ?? keyPair.keyVersion ?? 1,
      };
      await saveUserKeyPair(enrichedKeyPair);
      setCurrentUserKeys(enrichedKeyPair);
      setUserFingerprint(fp);
      setShowProfileDrawer(false);

      if (!socket.connected) connectSocket();
      socket.emit('user:join', { userId: enrichedKeyPair.userId, username: enrichedKeyPair.username, fullName: serverUser.fullName || enrichedKeyPair.fullName, role: enrichedKeyPair.role, publicKey: pubKeyBase64, signingPublicKey: enrichedKeyPair.signingPublicKeyBase64 });

      await fetchUserDirectory(data.token);
      socket.emit('channels:get');
    }
  };

  const handleLogout = () => {
    setIsLogoutOpen(true);
  };

  const handleLogoutConfirm = () => {
    removeJwtToken();
    setCurrentUserKeys(null);
    setPrivateKeyObject(null);
    setSelectedPeer(null);
    setSelectedChannel(null);
    setAllUsers([]);
    setOnlineIds(new Set());
    setShowAdmin(false);
    setAvatarMenu(null);
    if (socket.connected) socket.disconnect();
    // Reset history ref so fetchAllHistory runs on re-login
    historyFetchedRef.current = false;
    // Clear IndexedDB tables (not db.delete() which closes Dexie permanently)
    db.transaction('rw', [db.keys, db.messages, db.trustedKeys, db.channels, db.channelKeys], async () => {
      await db.keys.clear();
      await db.messages.clear();
      await db.trustedKeys.clear();
      await db.channels.clear();
      await db.channelKeys.clear();
    }).catch(() => {});
  };

  // ── Admin RBAC Handlers ──────────────────────────────────────────────────────
  const fetchAdminUsers = useCallback(async (): Promise<AdminUser[]> => {
    const token = getJwtToken();
    if (!token) return [];
    try {
      const res = await fetch(`${API_BASE}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 403) { showToast('Admin access required.', 'error'); return []; }
        return [];
      }
      const data = await res.json();
      return (data.users || []) as AdminUser[];
    } catch (e) {
      console.error('[Admin] Fetch error:', e);
      return [];
    }
  }, []);

  const handleAdminSetRole = useCallback(async (userId: string, role: UserRole) => {
    const token = getJwtToken();
    if (!token) return false;
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Role change failed', 'error');
        return false;
      }
      return true;
    } catch (e) {
      console.error('[Admin] Role change error:', e);
      return false;
    }
  }, []);

  const handleAdminDeleteUser = useCallback(async (userId: string): Promise<boolean> => {
    const token = getJwtToken();
    if (!token) return false;
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'User deletion failed', 'error');
        return false;
      }
      return true;
    } catch (e) {
      console.error('[Admin] Delete error:', e);
      return false;
    }
  }, []);

  // ── Socket Event Listeners ────────────────────────────────────────────────────
  useEffect(() => {
    const onUsersDirectory = (usersList: User[]) => {
      setAllUsers(usersList);
      const online = new Set(usersList.filter(u => u.isOnline).map(u => u.userId));
      setOnlineIds(online);
    };

    const onUsersPresence = (presence: { userId: string; isOnline: boolean; isAway?: boolean }[]) => {
      // Replace with server data (server sends complete presence list)
      const online = new Set(presence.filter(p => p.isOnline).map(p => p.userId));
      const away = new Set(presence.filter(p => p.isAway && p.isOnline).map(p => p.userId));
      setOnlineIds(online);
      setAwayIds(away);
    };

    const onChannelsUpdate = async (channelsList: Channel[]) => {
      setChannels(channelsList);
      // Also update selectedChannel if its properties changed (e.g. isAnnouncement toggle)
      setSelectedChannel(prev => {
        if (!prev) return prev;
        const updated = channelsList.find(c => c.id === prev.id);
        return updated ? { ...prev, ...updated } : prev;
      });
      // Clean up deleted channels from IndexedDB
      const serverIds = new Set(channelsList.map(c => c.id));
      const stored = await getStoredChannels();
      for (const ch of stored) {
        if (!serverIds.has(ch.id)) {
          await db.channels.delete(ch.id);
        }
      }
      for (const c of channelsList) await saveChannel(c);
    };

    const onMessageReceive = async (payload: EncryptedPayload & { isForwarded?: boolean }) => {
      if (!currentUserKeysRef.current || !privateKeyObjectRef.current) return;
      const localMsg = await decryptPayloadRef.current(payload);
      // Always save the message, even if decryption failed (show error to user)
      await saveMessage(localMsg);

      // Mark forwarded if sender flagged it
      if (payload.isForwarded) {
        await markForwarded(localMsg.id);
      }

      // Instant DM list update — move sender to top of sidebar
      const senderUser = allUsersRef.current.find(u => u.userId === payload.senderId);
      if (senderUser) {
        upsertDMConversation(senderUser, localMsg.text || 'Attachment');
      } else {
        // Fallback: search the state directly if ref is stale, or create placeholder
        const fallbackUser = allUsersRef.current.find(u => u.userId === payload.senderId);
        if (fallbackUser) {
          upsertDMConversation(fallbackUser, localMsg.text || 'Attachment');
        }
      }

      // 1. Emit delivery receipt back to server
      socket.emit('message:delivered', { messageId: payload.id, tempId: payload.tempId, senderId: payload.senderId });

      // Play notification sound if not the active conversation
      if (selectedPeerRef.current?.userId !== payload.senderId) {
        playNotificationSound();
      }

      // 2. If recipient ALREADY has this conversation thread open, emit read receipt immediately!
      if (selectedPeerRef.current?.userId === payload.senderId) {
        socket.emit('message:read', { conversationId: currentUserKeysRef.current?.userId, senderId: payload.senderId, lastReadMessageId: payload.id });
        // Update lastViewed so this message won't show as unread after refresh
        setLastViewedDms(prev => ({ ...prev, [payload.senderId]: localMsg.timestamp }));
        lastViewedDmsRef.current = { ...lastViewedDmsRef.current, [payload.senderId]: localMsg.timestamp };
      }
    };

    const onChannelMessageReceive = async (payload: EncryptedPayload & { isForwarded?: boolean }) => {
      if (!payload.channelId) return;
      const localMsg = await decryptPayloadRef.current(payload);
      // Always save the message, even if decryption failed (show error to user)
      await saveMessage(localMsg);

      // Mark forwarded if sender flagged it
      if (payload.isForwarded) {
        await markForwarded(localMsg.id);
      }

      // Emit delivery receipt back to server (channel-aware)
      socket.emit('message:delivered', { messageId: payload.id, tempId: payload.tempId, channelId: payload.channelId });

      // Play notification sound if not the active channel
      if (selectedChannelRef.current?.id !== payload.channelId) {
        playNotificationSound();
      }

      // If recipient ALREADY has this channel open, emit read receipt to all members
      if (selectedChannelRef.current?.id === payload.channelId) {
        socket.emit('message:read', { conversationId: payload.channelId, lastReadMessageId: payload.id });
        // Update lastViewed so this message won't show as unread after refresh
        setLastViewedChannels(prev => ({ ...prev, [payload.channelId!]: localMsg.timestamp }));
        lastViewedChannelsRef.current = { ...lastViewedChannelsRef.current, [payload.channelId!]: localMsg.timestamp };
      }
    };

    const onMessageAck = async ({ tempId, serverId, status, error }: { tempId: string; serverId: string; status: LocalMessage['status'] | 'failed'; error?: string }) => {
      if (status === 'failed') {
        // Server rejected the message — show the reason and remove the local copy
        if (error) showToast(error, 'error');
        const existing = await db.messages.get(tempId) || await db.messages.where('tempId').equals(tempId).first();
        if (existing) await db.messages.delete(existing.id);
        return;
      }
      await updateMessageStatus(tempId, status, serverId);
    };

    const onMessageDeliveredAck = async ({ id, tempId }: { id: string; tempId?: string }) => {
      // Use tempId for lookup if available (message may still have tempId as id before onMessageAck)
      const lookupId = tempId || id;
      await updateMessageStatus(lookupId, 'delivered');
    };

    const onMessageReadAck = async ({ conversationId }: { conversationId: string }) => {
      const myId = currentUserKeysRef.current?.userId;
      if (!myId) return;
      const sentMsgs = await db.messages.where('senderId').equals(myId).toArray();
      const unreadSent = sentMsgs.filter(m => 
        (m.recipientId === conversationId || m.channelId === conversationId) && 
        m.status !== 'read'
      );
      for (const m of unreadSent) {
        // Use put() for reliable Dexie observable triggering
        await db.messages.put({ ...m, status: 'read' as const });
      }
    };

    const onMessageEdited = async ({ id, newCiphertext, newIv }: { id: string; newCiphertext: string; newIv: string }) => {
      let decryptedText = '🔒 Unable to decrypt edited message';
      const existing = await db.messages.get(id);
      if (existing?.channelId) {
        const channelKey = await getOrGenerateChannelKeyRef.current(existing.channelId);
        if (channelKey) { try { decryptedText = await decryptMessage(newCiphertext, newIv, channelKey); } catch {} }
      } else {
        // Find the actual peer from the message, not the currently selected peer
        const myId = currentUserKeys?.userId;
        const peerId = existing?.senderId === myId ? existing?.recipientId : existing?.senderId;
        if (peerId) {
          const peer = allUsersRef.current.find(u => u.userId === peerId);
          if (peer?.publicKey) {
            const sharedKey = await getOrDeriveSharedKeyRef.current(peer.userId, peer.publicKey);
            if (sharedKey) { try { decryptedText = await decryptMessage(newCiphertext, newIv, sharedKey); } catch {} }
          }
        }
      }
      await editMessageLocally(id, decryptedText, newCiphertext, newIv);
    };

    const onMessageDeleted = async ({ id }: { id: string }) => {
      await markMessageDeletedLocally(id);
    };

    // Reactive roster: a new user just registered — refresh the directory.
    const onUserRegistered = async () => {
      const token = getJwtToken();
      if (token) await fetchUserDirectoryRef.current(token);
    };

    // Reactive roster: a user just came online — add their full data to allUsers
    // so E2EE decryption works for messages and attachments
    const onUserOnline = (user: User) => {
      setAllUsers(prev => {
        const existing = prev.find(u => u.userId === user.userId);
        if (existing) {
          // Update existing user with fresh data (public key may have changed)
          return prev.map(u => u.userId === user.userId ? { ...u, ...user, isOnline: true } : u);
        }
        // New user — add them
        return [...prev, { ...user, isOnline: true }];
      });
      setOnlineIds(prev => new Set([...prev, user.userId]));
    };

    // Reactive roster: presence changed — update online set instantly.
    const onUserStatusChange = (data: { userId: string; isOnline: boolean }) => {
      setOnlineIds(prev => {
        const next = new Set(prev);
        if (data.isOnline) next.add(data.userId);
        else next.delete(data.userId);
        return next;
      });
      // If a user came online but we don't have their full data, fetch the directory
      if (data.isOnline && !allUsersRef.current.find(u => u.userId === data.userId)) {
        const token = getJwtToken();
        if (token) fetchUserDirectoryRef.current(token);
      }
    };

    // Peer rotated their identity key — re-validate the signed chain locally.
    const onUserKeyRotated = async (data: { userId: string; publicKey: string; signingPublicKey: string; keyVersion: number; keyRotationSignature: string; oldPublicKey: string; oldSigningPublicKey?: string }) => {
      setAllUsers(prev => prev.map(u => u.userId === data.userId ? {
        ...u,
        publicKey: data.publicKey,
        signingPublicKey: data.signingPublicKey,
        keyVersion: data.keyVersion,
        keyRotationSignature: data.keyRotationSignature,
        oldPublicKey: data.oldPublicKey,
        oldSigningPublicKey: data.oldSigningPublicKey,
      } : u));
      if (selectedPeerRef.current?.userId === data.userId) {
        await validatePeerKeyTofuRef.current({ ...selectedPeerRef.current, ...data });
      }
    };

    const onUserRemoved = (data: { userId: string }) => {
      // Keep the user in allUsers but mark as deleted so their public key
      // is still available for decrypting cached messages
      setAllUsers(prev => prev.map(u => u.userId === data.userId ? { ...u, isOnline: false, statusMessage: '[deleted]' } : u));
    };

    const onUserRoleChange = async (data: { userId: string; role: UserRole }) => {
      setAllUsers(prev => prev.map(u => u.userId === data.userId ? { ...u, role: data.role } : u));
      if (currentUserKeys?.userId === data.userId) {
        const updated: UserKeyPair = { ...currentUserKeys, role: data.role };
        await saveUserKeyPair(updated);
        setCurrentUserKeys(updated);
      }
    };

    const onUserProfileUpdate = (data: { userId: string; fullName?: string; username?: string; avatarUrl?: string; statusMessage?: string; phone?: string }) => {
      setAllUsers(prev => prev.map(u => u.userId === data.userId ? {
        ...u,
        fullName: data.fullName ?? u.fullName,
        username: data.username ?? u.username,
        avatarUrl: data.avatarUrl ?? u.avatarUrl,
        statusMessage: data.statusMessage !== undefined ? data.statusMessage : u.statusMessage,
        phone: data.phone !== undefined ? data.phone : u.phone,
      } : u));
      if (currentUserKeys?.userId === data.userId) {
        setCurrentUserKeys(prev => prev ? {
          ...prev,
          fullName: data.fullName ?? prev.fullName,
          username: data.username ?? prev.username,
          avatarUrl: data.avatarUrl ?? prev.avatarUrl,
          statusMessage: data.statusMessage !== undefined ? data.statusMessage : prev.statusMessage,
          phone: data.phone !== undefined ? data.phone : prev.phone,
        } : prev);
      }
    };

    const onUserSuspended = (data: { reason?: string }) => {
      // Force logout on suspension
      if (socket.connected) socket.disconnect();
      localStorage.removeItem('petroshield_jwt');
      sessionStorage.removeItem('petroshield_jwt');
      setCurrentUserKeys(null);
      // Show suspension message before reloading
      showToast(data?.reason || 'Your account has been suspended by an administrator.', 'error');
      window.location.reload();
    };

    const onPasswordChanged = () => {
      // Force logout on password change from another session
      if (socket.connected) socket.disconnect();
      localStorage.removeItem('petroshield_jwt');
      sessionStorage.removeItem('petroshield_jwt');
      setCurrentUserKeys(null);
      showToast('Your password was changed. Please log in again.', 'warning');
      window.location.reload();
    };

    const onChannelMemberAdded = async (data: { channelId: string; userId: string }) => {
      // If the added member is the current user, refresh channels and request the key
      if (data.userId === currentUserKeysRef.current?.userId) {
        socket.emit('channels:get');
        // Proactively request the channel key from existing members
        socket.emit('channel:key:request', { channelId: data.channelId });
      }
      // Update the channel in the local state
      setChannels(prev => prev.map(c => 
        c.id === data.channelId ? { ...c, memberIds: [...new Set([...(c.memberIds || []), data.userId])] } : c
      ));
      // Distribute channel key to the new member (if we have the key — any member can do this)
      if (data.userId !== currentUserKeysRef.current?.userId && currentUserKeysRef.current) {
        const channelKey = await getOrGenerateChannelKeyRef.current(data.channelId);
        if (!channelKey) return;
        const newMember = allUsersRef.current.find(u => u.userId === data.userId);
        if (!newMember?.publicKey) return;
        try {
          const sharedKey = await getOrDeriveSharedKeyRef.current(data.userId, newMember.publicKey);
          if (!sharedKey) return;
          const exportedKey = await crypto.subtle.exportKey('jwk', channelKey);
          const encryptedData = await encryptChannelKeyForUser(exportedKey, sharedKey);
          const token = getJwtToken();
          if (token) {
            await fetch(`${API_BASE}/api/channels/${data.channelId}/keys`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ keys: [{ userId: data.userId, encryptedChannelKey: encryptedData.encryptedKey, iv: encryptedData.iv }] }),
            });
          }
        } catch (e) {
          console.error(`[ChannelKey] Failed to distribute key to new member ${data.userId}:`, e);
        }
      }
    };

    const onChannelMemberRemoved = (data: { channelId: string; userId: string }) => {
      // If the removed member is the current user, refresh channels to remove the channel
      if (data.userId === currentUserKeys?.userId) {
        socket.emit('channels:get');
        // If the removed channel was selected, close it
        if (selectedChannel?.id === data.channelId) {
          setSelectedChannel(null);
        }
      }
      // Update the channel in the local state
      setChannels(prev => prev.map(c => 
        c.id === data.channelId ? { ...c, memberIds: (c.memberIds || []).filter(id => id !== data.userId) } : c
      ));
    };

    // Security: Channel key rotation when members are removed (forward secrecy)
    const onChannelKeyRotated = async (data: { channelId: string; removedMemberIds: string[] }) => {
      const currentKeys = currentUserKeysRef.current;
      if (!currentKeys) return;
      // If I was removed, clear my local channel key
      if (data.removedMemberIds.includes(currentKeys.userId)) {
        setChannelKeysCache(prev => { const next = new Map(prev); next.delete(data.channelId); return next; });
        try { await db.channelKeys.delete(data.channelId); } catch {}
        return;
      }
      // Clear local key — only the creator will generate and distribute the new one
      setChannelKeysCache(prev => { const next = new Map(prev); next.delete(data.channelId); return next; });
      try { await db.channelKeys.delete(data.channelId); } catch {}

      // Only the channel creator should generate + distribute the new rotated key
      const channel = channelsRef.current.find(c => c.id === data.channelId);
      if (!channel || channel.createdBy !== currentKeys.userId) return;

      try {
        const newKeyObj = await generateChannelSymmetricKey();
        const newKeyJwk = await exportKeyToJwk(newKeyObj);
        setChannelKeysCache(prev => new Map(prev).set(data.channelId, newKeyObj));
        await saveChannelKey({ channelId: data.channelId, keyJwk: newKeyJwk });
        // Re-encrypt for all remaining members
        const currentMembers = (channel.memberIds || []).filter(id => !data.removedMemberIds.includes(id));
        const envelopes: { userId: string; encryptedChannelKey: string; iv: string }[] = [];
        for (const memberId of currentMembers) {
          const memberUser = allUsersRef.current.find(u => u.userId === memberId);
          if (!memberUser?.publicKey) continue;
          const sharedKey = await getOrDeriveSharedKeyRef.current(memberId, memberUser.publicKey);
          if (!sharedKey) continue;
          const exportedKey = await crypto.subtle.exportKey('jwk', newKeyObj);
          const encryptedData = await encryptChannelKeyForUser(exportedKey, sharedKey);
          envelopes.push({ userId: memberId, encryptedChannelKey: encryptedData.encryptedKey, iv: encryptedData.iv });
        }
        const token = getJwtToken();
        if (token && envelopes.length > 0) {
          await fetch(`${API_BASE}/api/channels/${data.channelId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ keys: envelopes }),
          });
        }
      } catch (e) {
        console.error('[ChannelKey] Rotation failed:', e);
      }
    };

    const onChannelOwnershipTransferred = (data: { channelId: string; fromUserId: string; toUserId: string }) => {
      setChannels(prev => prev.map(c =>
        c.id === data.channelId ? { ...c, createdBy: data.toUserId } : c
      ));
    };

    // Respond to key requests from other members who can't decrypt
    const onChannelKeyRequest = async (data: { channelId: string; requesterId: string }) => {
      if (!currentUserKeysRef.current) return;
      if (data.requesterId === currentUserKeysRef.current.userId) return; // Don't respond to self
      const channelKey = await getOrGenerateChannelKeyRef.current(data.channelId);
      if (!channelKey) return; // We don't have the key either
      const requester = allUsersRef.current.find(u => u.userId === data.requesterId);
      if (!requester?.publicKey) return;
      try {
        const sharedKey = await getOrDeriveSharedKeyRef.current(data.requesterId, requester.publicKey);
        if (!sharedKey) return;
        const exportedKey = await crypto.subtle.exportKey('jwk', channelKey);
        const encryptedData = await encryptChannelKeyForUser(exportedKey, sharedKey);
        const token = getJwtToken();
        if (token) {
          await fetch(`${API_BASE}/api/channels/${data.channelId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ keys: [{ userId: data.requesterId, encryptedChannelKey: encryptedData.encryptedKey, iv: encryptedData.iv }] }),
          });
          console.log(`[ChannelKey] Delivered key to requesting user ${data.requesterId} for channel ${data.channelId}`);
        }
      } catch (e) {
        console.error(`[ChannelKey] Failed to respond to key request:`, e);
      }
    };

    socket.on('users:directory', onUsersDirectory);
    socket.on('users:presence',  onUsersPresence);
    socket.on('channels:update', onChannelsUpdate);
    socket.on('message:receive', onMessageReceive);
    socket.on('channel:message:receive', onChannelMessageReceive);
    socket.on('message:ack',     onMessageAck);
    socket.on('message:delivered_ack', onMessageDeliveredAck);
    socket.on('message:read_ack', onMessageReadAck);
    socket.on('message:edited', onMessageEdited);
    socket.on('message:deleted', onMessageDeleted);
    socket.on('user:registered', onUserRegistered);
    socket.on('user:online', onUserOnline);
    socket.on('user:status_change', onUserStatusChange);
    socket.on('user:key_rotated', onUserKeyRotated);
    socket.on('user:removed', onUserRemoved);
    socket.on('user:role_change', onUserRoleChange);
    socket.on('user:profile-update', onUserProfileUpdate);
    socket.on('user:suspended', onUserSuspended);
    socket.on('user:password_changed', onPasswordChanged);
    socket.on('channel:member_added', onChannelMemberAdded);
    socket.on('channel:member_removed', onChannelMemberRemoved);
    socket.on('channel:key_rotated', onChannelKeyRotated);
    socket.on('channel:ownership_transferred', onChannelOwnershipTransferred);
    socket.on('channel:key_request', onChannelKeyRequest);

    // Typing indicators
    const onUserTyping = (data: { userId: string; username: string; channelId?: string; recipientId?: string }) => {
      const conversationId = data.channelId || data.recipientId;
      if (!conversationId) return;
      if (data.userId === currentUserKeys?.userId) return;
      setTypingUsers(prev => {
        const existing = prev[conversationId] || [];
        if (existing.includes(data.username)) return prev;
        return { ...prev, [conversationId]: [...existing, data.username] };
      });
      // Auto-clear after 3 seconds
      setTimeout(() => {
        setTypingUsers(prev => {
          const existing = prev[conversationId] || [];
          const updated = existing.filter(u => u !== data.username);
          if (updated.length === 0) {
            const next = { ...prev };
            delete next[conversationId];
            return next;
          }
          return { ...prev, [conversationId]: updated };
        });
      }, 3000);
    };

    const onUserStopTyping = (data: { userId: string; username?: string; channelId?: string; recipientId?: string }) => {
      const conversationId = data.channelId || data.recipientId;
      if (!conversationId) return;
      setTypingUsers(prev => {
        const existing = prev[conversationId] || [];
        const name = data.username || allUsers.find(u => u.userId === data.userId)?.username || '';
        const updated = existing.filter(u => u !== name);
        if (updated.length === 0) {
          const next = { ...prev };
          delete next[conversationId];
          return next;
        }
        return { ...prev, [conversationId]: updated };
      });
    };

    socket.on('user:typing', onUserTyping);
    socket.on('user:stop_typing', onUserStopTyping);

    // Pinned messages
    const onChannelPinned = (data: { channelId: string; pinned: { messageId: string; pinnedBy: string; pinnedAt: number }[] }) => {
      setPinnedMessages(prev => ({ ...prev, [data.channelId]: data.pinned }));
    };
    socket.on('channel:pinned', onChannelPinned);

    return () => {
      socket.off('users:directory', onUsersDirectory);
      socket.off('users:presence',  onUsersPresence);
      socket.off('channels:update', onChannelsUpdate);
      socket.off('message:receive', onMessageReceive);
      socket.off('channel:message:receive', onChannelMessageReceive);
      socket.off('message:ack',     onMessageAck);
      socket.off('message:delivered_ack', onMessageDeliveredAck);
      socket.off('message:read_ack', onMessageReadAck);
      socket.off('message:edited', onMessageEdited);
      socket.off('message:deleted', onMessageDeleted);
      socket.off('user:registered', onUserRegistered);
      socket.off('user:online', onUserOnline);
      socket.off('user:status_change', onUserStatusChange);
      socket.off('user:key_rotated', onUserKeyRotated);
      socket.off('user:removed', onUserRemoved);
      socket.off('user:role_change', onUserRoleChange);
      socket.off('user:profile-update', onUserProfileUpdate);
      socket.off('user:suspended', onUserSuspended);
      socket.off('user:password_changed', onPasswordChanged);
      socket.off('channel:member_added', onChannelMemberAdded);
      socket.off('channel:member_removed', onChannelMemberRemoved);
      socket.off('channel:key_rotated', onChannelKeyRotated);
      socket.off('channel:ownership_transferred', onChannelOwnershipTransferred);
      socket.off('channel:key_request', onChannelKeyRequest);
      socket.off('user:typing', onUserTyping);
      socket.off('user:stop_typing', onUserStopTyping);
      socket.off('channel:pinned', onChannelPinned);
    };
  }, []); // Stable — handlers use refs for latest state

  // ── Ctrl+K Search Shortcut ──────────────────────────────────────────────────
  useEffect(() => {
    const handleSearchShortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, []);

  // ── Compute unread DMs & Channels ───────────────────────────────────────────
  // Persist to localStorage
  useEffect(() => {
    localStorage.setItem('petroshield_lastViewedDms', JSON.stringify(lastViewedDms));
  }, [lastViewedDms]);

  useEffect(() => {
    localStorage.setItem('petroshield_lastViewedChannels', JSON.stringify(lastViewedChannels));
  }, [lastViewedChannels]);

  useEffect(() => {
    if (!currentUserKeys) return;
    const myId = currentUserKeys.userId;
    const computeUnread = async () => {
      const activePeerId = selectedPeerRef.current?.userId;
      const activeChannelId = selectedChannelRef.current?.id;
      // Only fetch messages where senderId is NOT me (incoming messages only)
      // Use two targeted queries instead of loading entire table
      const incomingDMs = await db.messages.where('recipientId').equals(myId).toArray();
      const incomingChannel = await db.messages.where('channelId').above('').toArray();
      const incoming = [...incomingDMs, ...incomingChannel.filter(m => m.senderId !== myId)];
      const dmCounts: Record<string, number> = {};
      const channelCounts: Record<string, number> = {};
      const latestMsgs: Record<string, { text: string; timestamp: number; fromMe: boolean }> = {};
      for (const msg of incoming) {
        if (msg.channelId) {
          if (msg.channelId === activeChannelId) continue;
          const lastViewed = lastViewedChannelsRef.current[msg.channelId] || 0;
          if (msg.timestamp > lastViewed) {
            channelCounts[msg.channelId] = (channelCounts[msg.channelId] || 0) + 1;
          }
        } else {
          const partnerId = msg.senderId;
          if (!partnerId) continue;
          if (partnerId === activePeerId) {
            // Still track latest message for preview even in open DM
            const existing = latestMsgs[partnerId];
            if (!existing || msg.timestamp > existing.timestamp) {
              latestMsgs[partnerId] = { text: msg.text || '📎 Attachment', timestamp: msg.timestamp, fromMe: false };
            }
            continue;
          }
          const lastViewed = lastViewedDmsRef.current[partnerId] || 0;
          if (msg.timestamp > lastViewed) {
            dmCounts[partnerId] = (dmCounts[partnerId] || 0) + 1;
          }
          // Track latest incoming message per partner
          const existing = latestMsgs[partnerId];
          if (!existing || msg.timestamp > existing.timestamp) {
            latestMsgs[partnerId] = { text: msg.text || '📎 Attachment', timestamp: msg.timestamp, fromMe: false };
          }
        }
      }
      // Also get latest outgoing DMs for preview
      const outgoingDMs = await db.messages.where('senderId').equals(myId).toArray();
      for (const msg of outgoingDMs) {
        if (msg.channelId) continue;
        const partnerId = msg.recipientId;
        if (!partnerId) continue;
        const existing = latestMsgs[partnerId];
        if (!existing || msg.timestamp > existing.timestamp) {
          latestMsgs[partnerId] = { text: `You: ${msg.text || '📎 Attachment'}`, timestamp: msg.timestamp, fromMe: true };
        }
      }
      setUnreadDMs(dmCounts);
      setUnreadChannels(channelCounts);
      const previewMap: Record<string, string> = {};
      for (const [partnerId, latest] of Object.entries(latestMsgs)) {
        previewMap[partnerId] = latest.text;
      }
      setLatestDMMessages(previewMap);
    };
    computeUnreadRef.current = computeUnread;
    computeUnread();
    // Reactively recompute when messages change (instead of polling every 2s)
    const sub = liveQuery(() => db.messages.count()).subscribe({
      next: () => { computeUnread(); },
      error: (e) => console.error('[Unread] Live query error:', e),
    });
    return () => sub.unsubscribe();
  }, [currentUserKeys]);

  // ── Offline Queue Auto-Flush ──────────────────────────────────────────────────
  const offlineQueueRef = useRef({ sharedKeysCache, privateKeyObject, allUsers });
  useEffect(() => { offlineQueueRef.current = { sharedKeysCache, privateKeyObject, allUsers }; }, [sharedKeysCache, privateKeyObject, allUsers]);

  const flushOfflineQueue = useCallback(() => {
    if (!currentUserKeys || isFlushing.current || !getJwtToken()) return;
    if (!socket.connected) return; // Don't try to flush if socket is down
    if (!navigator.onLine) return; // Don't flush while browser reports offline
    isFlushing.current = true;
    // Safety reset after 15s in case onQueueEmpty never fires
    const safetyTimer = setTimeout(() => { isFlushing.current = false; }, 15000);
    processOfflineQueue({
      senderId: currentUserKeys.userId,
      socket,
      token: getJwtToken() || '',
      sharedKeysCache: offlineQueueRef.current.sharedKeysCache,
      privateKey: offlineQueueRef.current.privateKeyObject,
      activeUsers: offlineQueueRef.current.allUsers,
      onMessageFlushed: (msg) => {
        if (msg.channelId) {
          socket.emit('channels:get');
        }
      },
      onQueueEmpty: () => { clearTimeout(safetyTimer); isFlushing.current = false; }
    }).catch(() => { clearTimeout(safetyTimer); isFlushing.current = false; });
  }, [currentUserKeys]);

  // Flush when socket connects (with delay to ensure socket is fully ready)
  useEffect(() => {
    if (networkStatus.isSocketConnected && navigator.onLine) {
      const timer = setTimeout(() => {
        // Re-check after delay — socket may have disconnected during the wait
        if (socket.connected && navigator.onLine) {
          flushOfflineQueue();
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [networkStatus.isSocketConnected, flushOfflineQueue]);

  // Also listen for socket connect event directly to catch edge cases
  useEffect(() => {
    const handleConnect = () => {
      // Re-join socket rooms first so server accepts our messages
      if (currentUserKeys) {
        socket.emit('user:join', {
          userId: currentUserKeys.userId,
          username: currentUserKeys.username,
          fullName: currentUserKeys.fullName,
          role: currentUserKeys.role,
          publicKey: currentUserKeys.publicKeyBase64,
          signingPublicKey: currentUserKeys.signingPublicKeyBase64,
        });
      }
      // Then flush offline queue after a short delay (only if still online)
      const flushTimer = setTimeout(() => {
        if (socket.connected && navigator.onLine) {
          flushOfflineQueue();
        }
      }, 1000);
    };
    socket.on('connect', handleConnect);
    return () => { socket.off('connect', handleConnect); };
  }, [flushOfflineQueue, currentUserKeys]);

  // Restart socket when browser comes back online (handles reconnection exhaustion)
  useEffect(() => {
    const handleOnline = () => {
      if (!socket.connected && currentUserKeys) {
        connectSocket();
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [currentUserKeys]);

  // Periodic check: flush pending messages whenever socket is connected
  useEffect(() => {
    if (!currentUserKeys) return;
    const interval = setInterval(async () => {
      if (socket.connected && !isFlushing.current) {
        const pending = await getPendingSyncMessages(currentUserKeys.userId);
        if (pending.length > 0) {
          flushOfflineQueue();
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [currentUserKeys, flushOfflineQueue]);

  // Check token expiry periodically and force logout if expired
  useEffect(() => {
    if (!currentUserKeys) return;
    const check = () => {
      if (isTokenExpired()) {
        handleLogoutConfirm();
      }
    };
    const interval = setInterval(check, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, [currentUserKeys]);

  // Load stored channels on mount, then clean up deleted ones when server data arrives
  useEffect(() => {
    getStoredChannels().then(channels => {
      setChannels(channels);
    });
    // Also fetch from server to clean up deleted channels
    const token = getJwtToken();
    if (token) {
      socket.emit('channels:get');
    }
  }, []);

  // ── Selection Handlers ────────────────────────────────────────────────────────

  const handleSelectPeer = async (user: User) => {
    setSelectedChannel(null);
    setSelectedPeer(user);
    if (!currentUserKeys) return;

    // Mark DM as viewed — update both state (for persistence) and ref (for immediate use by computeUnread)
    const now = Date.now();
    setLastViewedDms(prev => ({ ...prev, [user.userId]: now }));
    lastViewedDmsRef.current = { ...lastViewedDmsRef.current, [user.userId]: now };

    // Immediately recompute unread counts so badge clears instantly
    computeUnreadRef.current?.();

    // Emit read receipt for this DM thread
    // Find the last message to include as lastReadMessageId
    const lastMsg = await db.messages.where('[senderId+recipientId]').equals([user.userId, currentUserKeys.userId]).last().catch(() => undefined)
      || await db.messages.where('[senderId+recipientId]').equals([currentUserKeys.userId, user.userId]).last().catch(() => undefined);
    socket.emit('message:read', { conversationId: currentUserKeys.userId, senderId: user.userId, lastReadMessageId: lastMsg?.id });

    await validatePeerKeyTofu(user);
    const fp = await getFingerprint(user.publicKey);
    setPeerFingerprint(fp);

    const token = getJwtToken();
    if (token) {
      try {
        const res = await fetch(`${API_BASE}/api/messages/direct/${user.userId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          const serverMsgs: EncryptedPayload[] = data.messages || [];
          for (const payload of serverMsgs) {
            const local = await decryptPayload(payload);
            if (local) await saveMessage(local);
          }
        }
      } catch (e) {
        console.error('[History] Failed to fetch DM history:', e);
      }
    }
  };

  const handleSelectChannel = async (channel: Channel) => {
    setSelectedPeer(null);
    setSelectedChannel(channel);
    const now = Date.now();
    setLastViewedChannels(prev => ({ ...prev, [channel.id]: now }));
    lastViewedChannelsRef.current = { ...lastViewedChannelsRef.current, [channel.id]: now };
    computeUnreadRef.current?.();

    // Join channel room FIRST so we receive key distribution events
    socket.emit('channel:join', { channelId: channel.id });

    // Try to get the channel key — if missing, request from online members and retry
    let key = await getOrGenerateChannelKey(channel.id);
    if (!key) {
      socket.emit('channel:key:request', { channelId: channel.id });
      await new Promise(r => setTimeout(r, 2000));
      key = await getOrGenerateChannelKey(channel.id);
    }

    // Emit read receipt for this channel (broadcast to all members, not self)
    if (currentUserKeys) {
      const lastMsg = await db.messages.where('channelId').equals(channel.id).last().catch(() => undefined);
      socket.emit('message:read', { conversationId: channel.id, lastReadMessageId: lastMsg?.id });
    }
  };

  const handleCloseChat = () => {
    setSelectedPeer(null);
    setSelectedChannel(null);
  };

  const handleUserAvatarClick = useCallback((user: User, rect: DOMRect) => {
    setAvatarMenu({ user, rect });
  }, []);

  const handleUserPictureClick = useCallback((user: User) => {
    setAvatarMenu(null);
    setShowProfileDrawer(true);
  }, []);

  const handleAvatarMessage = useCallback(() => {
    if (avatarMenu?.user) {
      handleSelectPeer(avatarMenu.user);
      setMobileSidebarOpen(false);
      setAvatarMenu(null);
    }
  }, [avatarMenu, handleSelectPeer]);

  const handleAvatarViewPicture = useCallback(() => {
    if (avatarMenu?.user) {
      setShowProfileDrawer(true);
      setAvatarMenu(null);
    }
  }, [avatarMenu]);

  const handleAvatarViewProfile = useCallback(() => {
    if (avatarMenu?.user) {
      setShowProfileDrawer(true);
      setAvatarMenu(null);
    }
  }, [avatarMenu]);

  const handleAvatarCopyId = useCallback(() => {
    if (avatarMenu?.user) {
      navigator.clipboard.writeText(avatarMenu.user.userId);
      setAvatarMenu(null);
    }
  }, [avatarMenu]);

  const handleAvatarShowFingerprint = useCallback(() => {
    if (avatarMenu?.user) {
      setShowFingerprintModal(true);
      setAvatarMenu(null);
    }
  }, [avatarMenu]);

  const handleCreateChannel = async (channelData: { name: string; description: string; type: 'official' | 'team' | 'private'; isAnnouncement?: boolean; memberIds?: string[] }) => {
    if (!currentUserKeys) return;
    const channelId = channelData.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // 1. Generate AES channel key
    const channelKeyObj = await generateChannelSymmetricKey();
    const channelKeyJwk = await exportKeyToJwk(channelKeyObj);
    await saveChannelKey({ channelId, keyJwk: channelKeyJwk });
    setChannelKeysCache(prev => new Map(prev).set(channelId, channelKeyObj));

    // 2. Encrypt channel key for selected members (or all for official channels)
    const token = getJwtToken();
    const keyEnvelopes: { userId: string; encryptedChannelKey: string; iv: string }[] = [];
    
    // Determine which members to encrypt for
    const membersToEncryptFor = channelData.memberIds && channelData.memberIds.length > 0
      ? allUsers.filter(u => channelData.memberIds!.includes(u.userId))
      : allUsers;

    for (const member of membersToEncryptFor) {
      if (member.publicKey) {
        const sharedKey = await getOrDeriveSharedKey(member.userId, member.publicKey);
        if (sharedKey) {
          const env = await encryptChannelKeyForUser(channelKeyJwk, sharedKey);
          keyEnvelopes.push({
            userId: member.userId,
            encryptedChannelKey: env.encryptedKey,
            iv: env.iv
          });
        }
      }
    }

    // Include self envelope
    const selfSharedKey = await getOrDeriveSharedKey(currentUserKeys.userId, currentUserKeys.publicKeyBase64);
    if (selfSharedKey) {
      const env = await encryptChannelKeyForUser(channelKeyJwk, selfSharedKey);
      keyEnvelopes.push({
        userId: currentUserKeys.userId,
        encryptedChannelKey: env.encryptedKey,
        iv: env.iv
      });
    }

    // 3. Emit channel creation event and await ACK that channel is ready
    const channelReady = new Promise<void>((resolve) => {
      const onAck = (data: { channelId: string }) => {
        if (data.channelId === channelId) {
          socket.off('channel:create:ack', onAck);
          resolve();
        }
      };
      socket.on('channel:create:ack', onAck);
      // Timeout: resolve anyway after 3s to prevent hanging
      setTimeout(() => { socket.off('channel:create:ack', onAck); resolve(); }, 3000);
    });
    socket.emit('channel:create', { ...channelData, createdBy: currentUserKeys.userId });
    await channelReady;

    // 4. Post channel key envelopes with retry (server may still be adding members)
    if (token && keyEnvelopes.length > 0) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${API_BASE}/api/channels/${channelId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ keys: keyEnvelopes })
          });
          const result = await res.json().catch(() => ({}));
          console.log(`[ChannelKeys] Upload attempt ${attempt + 1}: status=${res.status}, stored=${result.count}/${keyEnvelopes.length}`);
          if (res.ok) break;
          // If 403 (member not added yet), retry after delay
          if (res.status === 403 && attempt < 2) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          break;
        } catch (e) {
          console.error(`[ChannelKeys] Upload attempt ${attempt + 1} failed:`, e);
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    // Fallback: re-fetch channels after a short delay in case broadcast is slow
    setTimeout(() => socket.emit('channels:get'), 500);
  };

  const handleUpdateChannel = async (id: string, data: Partial<Pick<Channel, 'name' | 'description' | 'memberIds' | 'isAnnouncement' | 'allowedRoles' | 'slowModeSeconds'>>) => {
    const token = getJwtToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to update channel', 'error');
        return;
      }
      const result = await res.json().catch(() => ({}));
      // Update the local Dexie channel immediately
      if (result.channel) {
        await saveChannel(result.channel);
        if (selectedChannel?.id === id) {
          setSelectedChannel(result.channel);
        }
      }
      // Also trigger full refresh via socket
      socket.emit('channels:get');

      // If new members were added, distribute channel key envelopes
      if (data.memberIds && currentUserKeys) {
        const channelKey = await getOrGenerateChannelKey(id);
        if (!channelKey) return;
        const actualNewMembers = data.memberIds.filter(mid => {
          // Include members that were just added (not already in the previous list)
          const prevChannel = channels.find(c => c.id === id);
          return !prevChannel?.memberIds?.includes(mid);
        });
        if (actualNewMembers.length > 0) {
          const envelopes: { userId: string; encryptedChannelKey: string; iv: string }[] = [];
          for (const mid of actualNewMembers) {
            const memberUser = allUsers.find(u => u.userId === mid);
            if (!memberUser?.publicKey) continue;
            try {
              const sharedKey = await getOrDeriveSharedKey(mid, memberUser.publicKey);
              if (!sharedKey) continue;
              const exportedKey = await crypto.subtle.exportKey('jwk', channelKey);
              const encryptedData = await encryptChannelKeyForUser(exportedKey, sharedKey);
              envelopes.push({ userId: mid, encryptedChannelKey: encryptedData.encryptedKey, iv: encryptedData.iv });
            } catch (e) {
              console.error(`[E2EE] Failed to distribute channel key to ${mid}:`, e);
            }
          }
          if (envelopes.length > 0) {
            await fetch(`${API_BASE}/api/channels/${id}/keys`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ keys: envelopes }),
            });
          }
        }
      }
    } catch (e) {
      console.error('[Channel] Update error:', e);
      showToast('Failed to update channel', 'error');
    }
  };

  const handleDeleteChannel = async (id: string) => {
    const token = getJwtToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/channels/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to delete channel', 'error');
        return;
      }
      socket.emit('channels:get');
      setChannelSettings(null);
    } catch (e) {
      console.error('[Channel] Delete error:', e);
      showToast('Failed to delete channel', 'error');
    }
  };

  const handleLeaveChannel = (channelId: string) => {
    socket.emit('channel:leave', { channelId });
    // If the left channel was selected, deselect it
    if (selectedChannel?.id === channelId) {
      setSelectedChannel(null);
      setActiveView('channels');
    }
  };

  // ── Pinning ─────────────────────────────────────────────────────────────────
  const handlePinMessage = useCallback((messageId: string) => {
    if (!currentUserKeys || !selectedChannel) return;
    socket.emit('message:pin', { channelId: selectedChannel.id, messageId, userId: currentUserKeys.userId });
  }, [currentUserKeys, selectedChannel]);

  const handleUnpinMessage = useCallback((messageId: string) => {
    if (!selectedChannel) return;
    socket.emit('message:unpin', { channelId: selectedChannel.id, messageId });
  }, [selectedChannel]);

  // ── Typing Indicators ──────────────────────────────────────────────────────
  const lastViewedDmsRef = useRef(lastViewedDms);
  useEffect(() => { lastViewedDmsRef.current = lastViewedDms; }, [lastViewedDms]);

  const lastViewedChannelsRef = useRef(lastViewedChannels);
  useEffect(() => { lastViewedChannelsRef.current = lastViewedChannels; }, [lastViewedChannels]);

  const computeUnreadRef = useRef<(() => Promise<void>) | null>(null);
  const historyFetchedRef = useRef(false);

  // Refs for callbacks that change frequently (to stabilize socket listener useEffect)
  const currentUserKeysRef = useRef(currentUserKeys);
  currentUserKeysRef.current = currentUserKeys;
  const privateKeyObjectRef = useRef(privateKeyObject);
  privateKeyObjectRef.current = privateKeyObject;
  const decryptPayloadRef = useRef(decryptPayload);
  decryptPayloadRef.current = decryptPayload;
  const fetchUserDirectoryRef = useRef(fetchUserDirectory);
  fetchUserDirectoryRef.current = fetchUserDirectory;
  const validatePeerKeyTofuRef = useRef(validatePeerKeyTofu);
  validatePeerKeyTofuRef.current = validatePeerKeyTofu;
  const getOrDeriveSharedKeyRef = useRef(getOrDeriveSharedKey);
  getOrDeriveSharedKeyRef.current = getOrDeriveSharedKey;
  const getOrGenerateChannelKeyRef = useRef(getOrGenerateChannelKey);
  getOrGenerateChannelKeyRef.current = getOrGenerateChannelKey;

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  const handleTypingStart = useCallback(() => {
    if (isTypingRef.current) return;
    isTypingRef.current = true;
    const payload: any = { userId: currentUserKeys?.userId, username: currentUserKeys?.username };
    if (selectedChannel) payload.channelId = selectedChannel.id;
    else if (selectedPeer) payload.recipientId = selectedPeer.userId;
    else return;
    socket.emit('user:typing', payload);
  }, [currentUserKeys, selectedChannel, selectedPeer]);

  const handleTypingStop = useCallback(() => {
    if (!isTypingRef.current) return;
    isTypingRef.current = false;
    const payload: any = { userId: currentUserKeys?.userId };
    if (selectedChannel) payload.channelId = selectedChannel.id;
    else if (selectedPeer) payload.recipientId = selectedPeer.userId;
    else return;
    socket.emit('user:stop_typing', payload);
  }, [currentUserKeys, selectedChannel, selectedPeer]);

  const handleTyping = useCallback(() => {
    handleTypingStart();
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(handleTypingStop, 3000);
  }, [handleTypingStart, handleTypingStop]);

  // ── Send Message ─────────────────────────────────────────────────────────────
  const handleSendMessage = async (text: string, replyTo?: string) => {
    if (!currentUserKeys || (!selectedPeer && !selectedChannel) || !privateKeyObject) return;
    const tempId = `temp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = Date.now();
    const canSend = socket.connected && navigator.onLine;
    const status: LocalMessage['status'] = canSend ? 'sent' : 'pending_sync';

    if (selectedChannel) {
      const channelKey = await getOrGenerateChannelKey(selectedChannel.id);
      if (!channelKey) {
        // Request key from online members, then retry once
        socket.emit('channel:key:request', { channelId: selectedChannel.id });
        await new Promise(r => setTimeout(r, 1500));
        const retryKey = await getOrGenerateChannelKey(selectedChannel.id);
        if (!retryKey) {
          // Fallback: if we are the channel creator, regenerate key and distribute to all members
          const isCreator = selectedChannel.createdBy === currentUserKeys.userId;
          if (isCreator) {
            showToast('Regenerating channel key (old messages may not decrypt)...', 'warning');
            const { generateChannelSymmetricKey, exportKeyToJwk } = await import('./lib/crypto');
            const newKeyObj = await generateChannelSymmetricKey();
            const newKeyJwk = await exportKeyToJwk(newKeyObj);
            await saveChannelKey({ channelId: selectedChannel.id, keyJwk: newKeyJwk });
            setChannelKeysCache(prev => new Map(prev).set(selectedChannel.id, newKeyObj));
            // Encrypt for all current members + self
            const token = getJwtToken();
            const keyEnvelopes: { userId: string; encryptedChannelKey: string; iv: string }[] = [];
            const memberIds = [...new Set([selectedChannel.createdBy, ...(selectedChannel.memberIds || [])])];
            for (const memberId of memberIds) {
              const member = allUsersRef.current.find(u => u.userId === memberId);
              if (member?.publicKey) {
                const sharedKey = await getOrDeriveSharedKeyRef.current(memberId, member.publicKey);
                if (sharedKey) {
                  const env = await encryptChannelKeyForUser(newKeyJwk, sharedKey);
                  keyEnvelopes.push({ userId: memberId, encryptedChannelKey: env.encryptedKey, iv: env.iv });
                }
              }
            }
            // Self envelope
            const selfSharedKey = await getOrDeriveSharedKeyRef.current(currentUserKeys.userId, currentUserKeys.publicKeyBase64);
            if (selfSharedKey) {
              const env = await encryptChannelKeyForUser(newKeyJwk, selfSharedKey);
              keyEnvelopes.push({ userId: currentUserKeys.userId, encryptedChannelKey: env.encryptedKey, iv: env.iv });
            }
            if (token && keyEnvelopes.length > 0) {
              await fetch(`${API_BASE}/api/channels/${selectedChannel.id}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ keys: keyEnvelopes }),
              });
            }
            const { ciphertext, iv } = await encryptMessage(text, newKeyObj);
            const localMsg: LocalMessage = { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: selectedChannel.id, text, ciphertext, iv, timestamp, status, isDecrypted: true, replyTo };
            await saveMessage(localMsg);
            if (canSend) {
              socket.emit('channel:message:send', { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: selectedChannel.id, ciphertext, iv, timestamp, replyTo });
            }
            return;
          }
          showToast('Cannot send: channel key unavailable (no online member has it).', 'error');
          return;
        }
        const { ciphertext, iv } = await encryptMessage(text, retryKey);
        const localMsg: LocalMessage = { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: selectedChannel.id, text, ciphertext, iv, timestamp, status, isDecrypted: true, replyTo };
        await saveMessage(localMsg);
        if (canSend) {
          socket.emit('channel:message:send', { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: selectedChannel.id, ciphertext, iv, timestamp, replyTo });
        }
        return;
      }
      const { ciphertext, iv } = await encryptMessage(text, channelKey);
      const localMsg: LocalMessage = { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: selectedChannel.id, text, ciphertext, iv, timestamp, status, isDecrypted: true, replyTo };
      await saveMessage(localMsg);
      if (canSend) {
        socket.emit('channel:message:send', { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: selectedChannel.id, ciphertext, iv, timestamp, replyTo });
      }
    } else if (selectedPeer) {
      const isValidKey = await validatePeerKeyTofu(selectedPeer);
      if (!isValidKey) { showToast('Security Alert: Peer identity key mismatch. Contact admin.', 'error'); return; }
      const sharedKey = await getOrDeriveSharedKey(selectedPeer.userId, selectedPeer.publicKey);
      if (!sharedKey) return;
      const { ciphertext, iv } = await encryptMessage(text, sharedKey);
      const localMsg: LocalMessage = { id: tempId, tempId, senderId: currentUserKeys.userId, recipientId: selectedPeer.userId, text, ciphertext, iv, timestamp, status, isDecrypted: true, replyTo };
      await saveMessage(localMsg);
      upsertDMConversation(selectedPeer, text);
      if (canSend) {
        socket.emit('message:send', { id: tempId, tempId, senderId: currentUserKeys.userId, recipientId: selectedPeer.userId, ciphertext, iv, timestamp, replyTo });
      }
    }
  };

  // ── Forward Message ─────────────────────────────────────────────────────────
  const handleForwardMessage = async (originalText: string, target: { type: 'dm'; userId: string } | { type: 'channel'; channelId: string }) => {
    if (!currentUserKeys || !privateKeyObject) return;
    const tempId = `temp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = Date.now();
    const canSend = socket.connected && navigator.onLine;
    const status: LocalMessage['status'] = canSend ? 'sent' : 'pending_sync';

    if (target.type === 'channel') {
      const channelKey = await getOrGenerateChannelKey(target.channelId);
      if (!channelKey) {
        socket.emit('channel:key:request', { channelId: target.channelId });
        await new Promise(r => setTimeout(r, 1500));
        const retryKey = await getOrGenerateChannelKey(target.channelId);
        if (!retryKey) {
          showToast('Cannot forward: channel key unavailable (no online member has it).', 'error');
          return;
        }
        const { ciphertext, iv } = await encryptMessage(originalText, retryKey);
        const localMsg: LocalMessage = { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: target.channelId, text: originalText, ciphertext, iv, timestamp, status, isDecrypted: true };
        await saveMessage(localMsg);
        await markForwarded(tempId);
        if (canSend) {
          socket.emit('channel:message:send', { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: target.channelId, ciphertext, iv, timestamp, isForwarded: true });
        }
        // Navigate to target channel
        const channel = channels.find(c => c.id === target.channelId);
        if (channel) handleSelectChannel(channel);
        return;
      }
      const { ciphertext, iv } = await encryptMessage(originalText, channelKey);
      const localMsg: LocalMessage = { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: target.channelId, text: originalText, ciphertext, iv, timestamp, status, isDecrypted: true };
      await saveMessage(localMsg);
      await markForwarded(tempId);
      if (canSend) {
        socket.emit('channel:message:send', { id: tempId, tempId, senderId: currentUserKeys.userId, channelId: target.channelId, ciphertext, iv, timestamp, isForwarded: true });
      }
      // Navigate to target channel
      const channel = channels.find(c => c.id === target.channelId);
      if (channel) handleSelectChannel(channel);
    } else {
      const peer = allUsers.find(u => u.userId === target.userId);
      if (!peer) return;
      const isValidKey = await validatePeerKeyTofu(peer);
      if (!isValidKey) { showToast('Security Alert: Peer identity key mismatch.', 'error'); return; }
      const sharedKey = await getOrDeriveSharedKey(peer.userId, peer.publicKey);
      if (!sharedKey) return;
      const { ciphertext, iv } = await encryptMessage(originalText, sharedKey);
      const localMsg: LocalMessage = { id: tempId, tempId, senderId: currentUserKeys.userId, recipientId: peer.userId, text: originalText, ciphertext, iv, timestamp, status, isDecrypted: true };
      await saveMessage(localMsg);
      await markForwarded(tempId);
      upsertDMConversation(peer, originalText);
      if (canSend) {
        socket.emit('message:send', { id: tempId, tempId, senderId: currentUserKeys.userId, recipientId: peer.userId, ciphertext, iv, timestamp, isForwarded: true });
      }
      // Navigate to target DM
      handleSelectPeer(peer);
    }
  };

  // ── Send Encrypted File Attachment ──────────────────────────────────────────
  const handleSendFiles = async (files: File[], text?: string) => {
    if (!currentUserKeys || (!selectedPeer && !selectedChannel) || !privateKeyObject || files.length === 0) return;

    let keyObj: CryptoKey | null = null;
    if (selectedChannel) {
      keyObj = await getOrGenerateChannelKey(selectedChannel.id);
    } else if (selectedPeer) {
      const isValidKey = await validatePeerKeyTofu(selectedPeer);
      if (!isValidKey) { showToast('Security Alert: Peer identity key mismatch. Contact admin.', 'error'); return; }
      keyObj = await getOrDeriveSharedKey(selectedPeer.userId, selectedPeer.publicKey);
    }
    if (!keyObj) return;

    const token = getJwtToken() || '';

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_ATTACHMENT_BYTES) {
        showToast(`File "${file.name}" exceeds the 25 MB limit.`, 'error');
        continue;
      }

      let thumbnailDataUrl: string | undefined;
      if (file.type.startsWith('image/')) {
        try { thumbnailDataUrl = await generateImageThumbnail(file); } catch { /* skip */ }
      }

      const buffer = await readFileAsArrayBuffer(file);
      const { ciphertext: encryptedBinary, iv: binaryIv } = await encryptBinaryData(buffer, keyObj);

      const meta: AttachmentMeta = {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        thumbnailDataUrl,
      };
      const { ciphertext: encryptedMetadata, iv: metadataIv } = await encryptMessage(JSON.stringify(meta), keyObj);

      let ciphertext = '';
      let ivStr = '';
      if (i === 0 && text && text.trim()) {
        const enc = await encryptMessage(text, keyObj);
        ciphertext = enc.ciphertext;
        ivStr = enc.iv;
      }

      const tempId = `temp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const timestamp = Date.now();
      const canSend = socket.connected && navigator.onLine;
      const status: LocalMessage['status'] = canSend ? 'sent' : 'pending_sync';
      const pendingUpload: PendingUpload = { encryptedBinary, binaryIv, encryptedMetadata, metadataIv };
      const attachment: AttachmentPayload = { attachmentId: '', encryptedMetadata, iv: metadataIv, binaryIv };

      const localMsg: LocalMessage = {
        id: tempId, tempId,
        senderId: currentUserKeys.userId,
        recipientId: selectedPeer?.userId,
        channelId: selectedChannel?.id,
        text: i === 0 ? (text || '') : '', ciphertext, iv: ivStr,
        timestamp, status, isDecrypted: true,
        attachment, attachmentMeta: meta,
        pendingUpload,
      };
      await saveMessage(localMsg);

      if (!canSend) {
        console.log('[Attachment] Queued for upload when reconnected.');
        continue;
      }

      try {
        setUploadProgress(0);
        const attachmentId = await uploadEncryptedAttachment(token, pendingUpload, (pct) => setUploadProgress(pct));
        setUploadProgress(null);
        attachment.attachmentId = attachmentId;
        const sentMsg: LocalMessage = { ...localMsg, attachment, pendingUpload: undefined };
        await saveMessage(sentMsg);

        if (selectedChannel) {
          socket.emit('channel:message:send', {
            id: tempId, tempId, senderId: currentUserKeys.userId, channelId: selectedChannel.id,
            ciphertext, iv: ivStr, timestamp, attachment,
          });
        } else if (selectedPeer) {
          socket.emit('message:send', {
            id: tempId, tempId, senderId: currentUserKeys.userId, recipientId: selectedPeer.userId,
            ciphertext, iv: ivStr, timestamp, attachment,
          });
        }
        console.log(`[Attachment] Uploaded ${file.name} (${file.size} bytes) encrypted.`);
      } catch (e) {
        setUploadProgress(null);
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Attachment] Upload failed:', msg);
        showToast(`Failed to upload attachment: ${msg}`, 'error');
      }
    }
  };

  // ── Edit & Delete ─────────────────────────────────────────────────────────────
  const handleEditMessage = async (messageId: string, newText: string) => {
    if (!currentUserKeys) return;
    // Look up the message in DB to find the correct conversation key
    const msg = await db.messages.get(messageId);
    let keyObj: CryptoKey | null = null;
    if (msg?.channelId) {
      keyObj = await getOrGenerateChannelKey(msg.channelId);
    } else if (msg) {
      const peerId = msg.senderId === currentUserKeys.userId ? msg.recipientId : msg.senderId;
      if (peerId) {
        const peer = allUsersRef.current.find(u => u.userId === peerId);
        if (peer?.publicKey) keyObj = await getOrDeriveSharedKey(peerId, peer.publicKey);
      }
    }
    if (!keyObj) return;
    const { ciphertext, iv } = await encryptMessage(newText, keyObj);
    await editMessageLocally(messageId, newText, ciphertext, iv);
    socket.emit('message:edit', { id: messageId, newCiphertext: ciphertext, newIv: iv, recipientId: msg?.recipientId, channelId: msg?.channelId });
  };

  const handleDeleteForMe = async (messageId: string) => {
    await deleteMessageLocally(messageId);
  };

  const handleDeleteForEveryone = async (messageId: string) => {
    await markMessageDeletedLocally(messageId);
    const payload = { id: messageId, recipientId: selectedPeer?.userId, channelId: selectedChannel?.id };
    if (socket.connected) {
      socket.emit('message:delete', payload);
    } else {
      // Retry when socket reconnects
      const retryHandler = () => { socket.emit('message:delete', payload); };
      socket.once('connect', retryHandler);
      setTimeout(() => socket.off('connect', retryHandler), 30000);
    }
  };

  const usersWithPresence: User[] = allUsers.map(u => ({
    ...u,
    isOnline: onlineIds.has(u.userId),
    isAway: onlineIds.has(u.userId) && awayIds.has(u.userId),
  }));

  // Live version of selectedPeer that updates when onlineIds changes
  const selectedPeerWithPresence = selectedPeer
    ? usersWithPresence.find(u => u.userId === selectedPeer.userId) || selectedPeer
    : null;

  if (isRehydrating) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-muted)' }}>
        <div className="w-12 h-12 rounded-full animate-spin mb-4" style={{ border: '2px solid var(--accent-primary)', borderTopColor: 'transparent' }} />
        <p className="text-xs tracking-widest">REHYDRATING PETROSHIELD SESSION…</p>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex overflow-hidden font-sans select-none">
      {/* Primary Sidebar Navigation (Logo, Channels, DMs, Collapsible Toggle, Profile Footer) */}
      {currentUserKeys && (
        <>
          {/* Mobile backdrop */}
          <div
            className={`mobile-backdrop ${mobileSidebarOpen ? 'open' : ''}`}
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className={`mobile-sidebar ${mobileSidebarOpen ? 'mobile-sidebar-open' : ''}`}>
          <Sidebar
            users={usersWithPresence}
            channels={channels}
            currentUser={currentUserKeys}
            selectedUser={selectedPeer}
            selectedChannel={selectedChannel}
            activeView={activeView}
            adminTab={adminTab}
            userFingerprint={userFingerprint}
            isAdmin={currentUserKeys.role === 'ADMIN'}
            showAdmin={showAdmin}
            onSelectView={(view) => { setShowAdmin(false); setActiveView(view); setMobileSidebarOpen(false); }}
            onSelectUser={(user) => { setShowAdmin(false); handleSelectPeer(user); setMobileSidebarOpen(false); }}
            onSelectChannel={(ch) => { setShowAdmin(false); handleSelectChannel(ch); setMobileSidebarOpen(false); }}
            onCreateChannel={handleCreateChannel}
            onShowFingerprintModal={() => setShowFingerprintModal(true)}
            onOpenProfileDrawer={() => setShowProfileDrawer(true)}
            onOpenChannelSettings={(channel) => setChannelSettings(channel)}
            onToggleAdmin={() => setShowAdmin(prev => !prev)}
            onSelectAdminTab={(tab) => { setShowAdmin(true); setAdminTab(tab); }}
            onLogout={handleLogout}
            unreadDMs={unreadDMs}
            unreadChannels={unreadChannels}
            recentDMs={recentDMs}
            latestDMMessages={latestDMMessages}
            onCloseDM={(userId) => {
              if (selectedPeer?.userId === userId) {
                setSelectedPeer(null);
                setActiveView('channels');
              }
            }}
          />
          </div>
        </>
      )}

      {showAdmin && currentUserKeys?.role === 'ADMIN' ? (
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center" style={{ backgroundColor: 'var(--bg-app)' }}><Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-primary)' }} /></div>}>
          <AdminDashboard
            currentUser={currentUserKeys}
            fetchUsers={fetchAdminUsers}
            onSetRole={handleAdminSetRole}
            onDeleteUser={handleAdminDeleteUser}
            onClose={() => setShowAdmin(false)}
            activeTab={adminTab}
          />
        </React.Suspense>
      ) : (
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Offline Banner */}
        {isOffline && currentUserKeys && <OfflineBanner pendingCount={pendingCount} />}

        {/* Main Workspace Feed */}
        <div className="flex-1 flex overflow-hidden relative">
          <div className="flex-1 flex flex-col h-full overflow-hidden relative">
            <ChatArea
              selectedUser={selectedPeerWithPresence}
              selectedChannel={selectedChannel}
              currentUserId={currentUserKeys?.userId || ''}
              currentUserKeys={currentUserKeys}
              allUsers={usersWithPresence}
              peerFingerprint={peerFingerprint}
              mitmWarning={selectedPeer ? mitmWarnings[selectedPeer.userId] : false}
              isConnected={networkStatus.isSocketConnected}
              typingUsers={selectedChannel ? (typingUsers[selectedChannel.id] || []) : selectedPeer ? (typingUsers[selectedPeer.userId] || []) : []}
              fingerprint={userFingerprint}
              showFingerprintModal={showFingerprintModal}
              onCloseChat={handleCloseChat}
              onTrustNewKey={handleTrustNewKey}
              onEditMessage={handleEditMessage}
              onDeleteForMe={handleDeleteForMe}
              onDeleteForEveryone={handleDeleteForEveryone}
              resolveMessageKey={resolveMessageKey}
              onSendMessage={handleSendMessage}
              onSendFiles={handleSendFiles}
              uploadProgress={uploadProgress}
              pinnedMessages={selectedChannel ? (pinnedMessages[selectedChannel.id] || []) : []}
              onPin={handlePinMessage}
              onUnpin={handleUnpinMessage}
              onOpenChannelSettings={(ch) => setChannelSettings(ch)}
              onOpenSearch={() => setShowSearch(true)}
              onOpenFingerprintModal={() => setShowFingerprintModal(true)}
              onCloseFingerprintModal={() => setShowFingerprintModal(false)}
              onToggleSidebar={() => setMobileSidebarOpen(prev => !prev)}
              onForwardMessage={handleForwardMessage}
              channels={channels}
              onBlockUser={(userId) => {
                setAllUsers(prev => prev.map(u => u.userId === userId ? { ...u, blockedByMe: true } : u));
              }}
              onUnblockUser={(userId) => {
                setAllUsers(prev => prev.map(u => u.userId === userId ? { ...u, blockedByMe: false } : u));
              }}
            />
          </div>
        </div>
      </div>
      )}

      {!currentUserKeys && (
        <AuthModal onAuthenticate={handleAuthenticate} error={authError} />
      )}

{showProfileDrawer && currentUserKeys && (
        <ProfileDrawer
          currentUser={currentUserKeys}
          userFingerprint={userFingerprint}
          onClose={() => setShowProfileDrawer(false)}
          onLogout={handleLogout}
          onUpdateProfile={handleUpdateProfile}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}

      {/* Logout confirmation modal */}
      <ConfirmModal
        isOpen={isLogoutOpen}
        title="Log out?"
        description="Are you sure you want to log out?"
        confirmLabel="Log out"
        cancelLabel="Stay signed in"
        isDangerous={true}
        onConfirm={handleLogoutConfirm}
        onClose={() => setIsLogoutOpen(false)}
      />

      {avatarMenu && (
        <UserAvatarMenu
          user={avatarMenu.user}
          rect={avatarMenu.rect}
          onClose={() => setAvatarMenu(null)}
          onMessage={handleAvatarMessage}
          onViewPicture={handleAvatarViewPicture}
          onViewProfile={handleAvatarViewProfile}
          onCopyId={handleAvatarCopyId}
          onShowFingerprint={handleAvatarShowFingerprint}
        />
      )}

      {channelSettings && currentUserKeys && (
        <ChannelSettingsModal
          channel={channelSettings}
          isOpen={true}
          onClose={() => setChannelSettings(null)}
          onUpdate={handleUpdateChannel}
          onDelete={handleDeleteChannel}
          allUsers={allUsers}
          currentUser={currentUserKeys}
          onMemberClick={(user) => {
            setChannelSettings(null);
            handleSelectPeer(user);
          }}
          onLeaveChannel={handleLeaveChannel}
        />
      )}

      <React.Suspense fallback={null}>
        <MessageSearch
          isOpen={showSearch}
          onClose={() => setShowSearch(false)}
          onSelectMessage={(msg) => {
            if (msg.channelId) {
              const ch = channels.find(c => c.id === msg.channelId);
              if (ch) handleSelectChannel(ch);
            } else {
              const peer = allUsers.find(u => u.userId === msg.senderId || u.userId === msg.recipientId);
              if (peer) handleSelectPeer(peer);
            }
          }}
          allUsers={allUsers}
          channels={channels}
          selectedUser={selectedPeer}
          selectedChannel={selectedChannel}
          currentUserId={currentUserKeys?.userId}
        />
</React.Suspense>
      <ToastContainer />
    </div>
  );
};
