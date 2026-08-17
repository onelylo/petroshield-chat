import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, saveDraft, getDraft, deleteDraft, getForwardedStatus, getBlockedUsers, blockUser, unblockUser } from '../lib/db';
import { socket } from '../lib/socket';
import { showToast } from '../lib/toast';
import {
  Lock, Shield, ShieldAlert, X, Paperclip, Send, Loader2, Reply,
  Search, Menu, ShieldCheck, Mic, ArrowDown, Info, FileText,
} from 'lucide-react';
import type { User, Channel, LocalMessage, UserKeyPair } from '../types/chat';
import { AttachmentMessage } from './AttachmentMessage';
import { ImageLightboxModal } from './modals/ImageLightboxModal';
import { ConfirmModal } from './modals/ConfirmModal';
import { ProfileModal } from './ProfileModal';
import { MessageItem } from './chat/MessageItem';
import { ForwardModal } from './modals/ForwardModal';
import { MAX_ATTACHMENT_BYTES, formatFileSize, generateImageThumbnail, API_BASE } from '../lib/attachments';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

interface ChatAreaProps {
  selectedUser: User | null;
  selectedChannel: Channel | null;
  currentUserId: string;
  currentUserKeys: UserKeyPair | null;
  allUsers: User[];
  peerFingerprint: string;
  mitmWarning?: boolean;
  isConnected?: boolean;
  typingUsers?: string[];
  fingerprint?: string;
  showFingerprintModal?: boolean;
  onCloseChat: () => void;
  onTrustNewKey?: (peer: User) => void;
  onEditMessage: (messageId: string, newText: string) => void;
  onDeleteForMe: (messageId: string) => void;
  onDeleteForEveryone: (messageId: string) => void;
  resolveMessageKey: (msg: LocalMessage) => Promise<CryptoKey | null>;
  onSendMessage: (text: string, replyTo?: string) => void;
  onSendFiles: (files: File[], text?: string) => void;
  uploadProgress: number | null;
  pinnedMessages: { messageId: string; pinnedBy: string; pinnedAt: number }[];
  onPin?: (messageId: string) => void;
  onUnpin?: (messageId: string) => void;
  onOpenChannelSettings?: (channel: Channel) => void;
  onOpenSearch?: () => void;
  onOpenFingerprintModal?: () => void;
  onCloseFingerprintModal?: () => void;
  onToggleSidebar?: () => void;
  onForwardMessage?: (originalText: string, target: { type: 'dm'; userId: string } | { type: 'channel'; channelId: string }) => void;
  channels?: Channel[];
  onBlockUser?: (userId: string) => void;
  onUnblockUser?: (userId: string) => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  selectedUser,
  selectedChannel,
  currentUserId,
  currentUserKeys,
  allUsers,
  peerFingerprint,
  mitmWarning,
  isConnected = true,
  typingUsers = [],
  fingerprint,
  showFingerprintModal,
  onCloseChat,
  onTrustNewKey,
  onEditMessage,
  onDeleteForMe,
  onDeleteForEveryone,
  resolveMessageKey,
  onSendMessage,
  onSendFiles,
  uploadProgress,
  pinnedMessages,
  onPin,
  onUnpin,
  onOpenChannelSettings,
  onOpenSearch,
  onOpenFingerprintModal,
  onCloseFingerprintModal,
  onToggleSidebar,
  onForwardMessage,
  channels = [],
  onBlockUser,
  onUnblockUser,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onSendFilesRef = useRef(onSendFiles);
  onSendFilesRef.current = onSendFiles;

  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const [text, setText] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);

  // Drafts: load when switching conversations
  useEffect(() => {
    const convId = selectedChannel?.id || selectedUser?.userId;
    if (!convId) return;
    getDraft(convId).then(draft => {
      if (draft) setText(draft);
    });
  }, [selectedChannel?.id, selectedUser?.userId]);

  // Drafts: auto-save as user types (debounced)
  useEffect(() => {
    const convId = selectedChannel?.id || selectedUser?.userId;
    if (!convId) return;
    if (!text.trim()) return; // Don't save empty drafts
    const timer = setTimeout(() => {
      saveDraft(convId, text);
    }, 500);
    return () => clearTimeout(timer);
  }, [text, selectedChannel?.id, selectedUser?.userId]);

  const [activeReply, setActiveReply] = useState<{ msgId: string; senderName: string; text: string } | null>(null);
  const [activeLightbox, setActiveLightbox] = useState<{ url: string; name?: string } | null>(null);
  const [forwardMsg, setForwardMsg] = useState<LocalMessage | null>(null);
  const [inspectedUser, setInspectedUser] = useState<User | null>(null);
  const [pendingDeleteForMeId, setPendingDeleteForMeId] = useState<string | null>(null);
  const [pendingDeleteEveryoneId, setPendingDeleteEveryoneId] = useState<string | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<Set<string>>(new Set());

  useEffect(() => {
    getBlockedUsers().then(setBlockedUsers);
  }, []);

  // Cleanup voice recorder on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      }
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    };
  }, []);

  const userLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of allUsers) {
      map.set(u.userId, u.fullName || u.username);
    }
    return map;
  }, [allUsers]);

  // Lazy loading: start with 50 messages, load more on scroll to top
  const INITIAL_LOAD = 50;
  const [loadCount, setLoadCount] = useState(INITIAL_LOAD);
  const [allMessages, setAllMessages] = useState<LocalMessage[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  // Fetch all messages for current conversation
  const messages = useLiveQuery(
    async () => {
      if (selectedChannel) {
        const msgs = await db.messages.where('channelId').equals(selectedChannel.id).toArray();
        return msgs.sort((a, b) => a.timestamp - b.timestamp);
      }
      if (selectedUser && currentUserId) {
        const [sent, received] = await Promise.all([
          db.messages.where('[senderId+recipientId]').equals([currentUserId, selectedUser.userId]).toArray(),
          db.messages.where('[senderId+recipientId]').equals([selectedUser.userId, currentUserId]).toArray(),
        ]);
        return [...sent, ...received].sort((a, b) => a.timestamp - b.timestamp);
      }
      return [];
    },
    [selectedUser?.userId, selectedChannel?.id, currentUserId],
    undefined
  );

  // Reset load count when switching conversations
  useEffect(() => {
    setLoadCount(INITIAL_LOAD);
    setAllMessages([]);
  }, [selectedUser?.userId, selectedChannel?.id]);

  // Update allMessages when messages change (liveQuery handles reactivity)
  useEffect(() => {
    if (messages) setAllMessages(messages);
  }, [messages]);

  // Visible messages (lazy loaded, filter out removed)
  const visibleMessages = allMessages.filter(m => !m.removed).slice(-loadCount);

  // Reactions: Map<messageId, {userId: string, emoji: string}[]>
  type ReactionEntry = { userId: string; emoji: string };
  const [reactionsMap, setReactionsMap] = useState<Map<string, ReactionEntry[]>>(new Map());

  // Fetch reactions when visible messages change
  useEffect(() => {
    if (!visibleMessages || visibleMessages.length === 0) return;
    const ids = visibleMessages.map(m => m.id);
    const token = localStorage.getItem('petroshield_jwt');
    if (!token) return;
    const controller = new AbortController();
    fetch(`${API_BASE}/api/reactions/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messageIds: ids }),
      signal: controller.signal,
    })
      .then(r => r.json())
      .then((data: { reactions: Record<string, ReactionEntry[]> }) => {
        setReactionsMap(prev => {
          const next = new Map<string, ReactionEntry[]>();
          for (const [msgId, reactions] of Object.entries(data.reactions || {})) {
            next.set(msgId, reactions);
          }
          // Preserve any existing local reactions
          for (const [msgId, localReactions] of prev.entries()) {
            const serverReactions = next.get(msgId) || [];
            const merged = [...serverReactions];
            for (const localR of localReactions) {
              if (!serverReactions.some(r => r.userId === localR.userId && r.emoji === localR.emoji)) {
                merged.push(localR);
              }
            }
            next.set(msgId, merged);
          }
          return next;
        });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [visibleMessages?.map(m => m.id).join(',')]);

  // Listen for live reaction updates
  useEffect(() => {
    const handleReactions = (data: { messageId: string; reactions: ReactionEntry[] }) => {
      setReactionsMap(prev => {
        const next = new Map(prev);
        next.set(data.messageId, data.reactions);
        return next;
      });
    };
    socket.on('message:reactions', handleReactions);
    return () => { socket.off('message:reactions', handleReactions); };
  }, []);

  const handleAddReaction = useCallback((messageId: string, emoji: string) => {
    // Optimistic update: show the reaction immediately
    setReactionsMap(prev => {
      const next = new Map(prev);
      const existing = next.get(messageId) || [];
      const hasOwn = existing.some(r => r.emoji === emoji && r.userId === currentUserId);
      if (!hasOwn) {
        next.set(messageId, [...existing, { userId: currentUserId || '', emoji }]);
      }
      return next;
    });
    socket.emit('reaction:add', { messageId, emoji });
  }, [currentUserId]);

  const handleRemoveReaction = useCallback((messageId: string, emoji: string) => {
    // Optimistic update: remove the reaction immediately
    setReactionsMap(prev => {
      const next = new Map(prev);
      const existing = next.get(messageId) || [];
      next.set(messageId, existing.filter(r => !(r.emoji === emoji && r.userId === currentUserId)));
      return next;
    });
    socket.emit('reaction:remove', { messageId, emoji });
  }, [currentUserId]);

  // Starred messages
  const [starredSet, setStarredSet] = useState<Set<string>>(new Set());

  // Forwarded messages
  const [forwardedSet, setForwardedSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visibleMessages || visibleMessages.length === 0) return;
    const ids = visibleMessages.map(m => m.id);
    const token = localStorage.getItem('petroshield_jwt');
    if (!token) return;
    fetch(`${API_BASE}/api/starred/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messageIds: ids }),
    })
      .then(r => r.json())
      .then((data: { status: Record<string, boolean> }) => {
        setStarredSet(new Set(Object.keys(data.status || {}).filter(k => data.status[k])));
      })
      .catch(() => {});

    getForwardedStatus(ids).then(setForwardedSet);
  }, [visibleMessages?.map(m => m.id).join(',')]);

  const handleToggleStar = useCallback(async (messageId: string, isStarred: boolean) => {
    const token = localStorage.getItem('petroshield_jwt');
    if (!token) return;
    if (isStarred) {
      setStarredSet(prev => { const next = new Set(prev); next.delete(messageId); return next; });
      await fetch(`${API_BASE}/api/starred/${messageId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    } else {
      setStarredSet(prev => new Set(prev).add(messageId));
      await fetch(`${API_BASE}/api/starred`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messageId }),
      }).catch(() => {});
    }
  }, []);

  // Load more when scrolling to top
  const handleScrollTop = useCallback(() => {
    if (loadingMore || !allMessages || loadCount >= allMessages.length) return;
    setLoadingMore(true);
    setTimeout(() => {
      setLoadCount(prev => Math.min(prev + 50, allMessages.length));
      setLoadingMore(false);
    }, 200);
  }, [loadingMore, loadCount, allMessages]);

  // Track whether user is near bottom for smart auto-scroll
  const isNearBottomRef = useRef(true);
  // Track whether we just switched conversations (for scroll-to-bottom)
  const justSwitchedRef = useRef(false);
  // Track whether user just sent a message (force scroll even if scrolled up)
  const justSentRef = useRef(false);

  // Helper: scroll the container to absolute bottom by setting scrollTop
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    // scrollHeight - clientHeight is the maximum scrollTop value
    const maxScroll = el.scrollHeight - el.clientHeight;
    el.scrollTo({ top: maxScroll, behavior: smooth ? 'smooth' : 'instant' });
    isNearBottomRef.current = true;
    setShowScrollDown(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 50px threshold — anything within 50px of bottom = "at bottom"
    isNearBottomRef.current = distFromBottom < 50;
    setShowScrollDown(distFromBottom >= 50);
    if (el.scrollTop < 100) handleScrollTop();
  }, [handleScrollTop]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.addEventListener('scroll', handleScroll, { passive: true });
      return () => scrollRef.current?.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll, selectedUser?.userId, selectedChannel?.id]);

  // Force scroll to bottom when switching conversations
  const switchKey = `${selectedUser?.userId || ''}-${selectedChannel?.id || ''}`;
  const prevSwitchKey = useRef(switchKey);

  useEffect(() => {
    if (switchKey !== prevSwitchKey.current) {
      prevSwitchKey.current = switchKey;
      justSwitchedRef.current = true;
    }
  }, [switchKey]);

  useEffect(() => {
    if (!justSwitchedRef.current || !scrollRef.current) return;
    const timer = setTimeout(() => {
      scrollToBottom(false);
      justSwitchedRef.current = false;
    }, 50);
    return () => clearTimeout(timer);
  }, [switchKey, scrollToBottom]);

  // Auto-scroll: watch allMessages length (NOT visibleMessages — sliced array may not change size)
  const prevAllMsgCountRef = useRef(allMessages?.length || 0);
  useEffect(() => {
    const newCount = allMessages?.length || 0;
    const prevCount = prevAllMsgCountRef.current;
    prevAllMsgCountRef.current = newCount;

    if (newCount > prevCount) {
      const shouldScroll = justSentRef.current || (isNearBottomRef.current && !justSwitchedRef.current);
      justSentRef.current = false;
      if (shouldScroll) {
        // Double rAF: first frame lets React render, second frame lets layout settle
        const timer = requestAnimationFrame(() => {
          requestAnimationFrame(() => scrollToBottom(false));
        });
        return () => cancelAnimationFrame(timer);
      }
    }
  }, [allMessages?.length, scrollToBottom]);

  // Textarea auto-resize
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const doSend = () => {
    if (!selectedUser && !selectedChannel) return;
    if (isBlockedDM) return;

    if (selectedFiles.length > 0) {
      onSendFiles(selectedFiles, text.trim() || undefined);
      setSelectedFiles([]);
      setPreviewDataUrl(null);
      setText('');
      const convId = selectedChannel?.id || selectedUser?.userId;
      if (convId) deleteDraft(convId);
      setActiveReply(null);
      justSentRef.current = true;
      return;
    }

    if (text.trim()) {
      onSendMessage(text.trim(), activeReply?.msgId);
      setText('');
      const convId = selectedChannel?.id || selectedUser?.userId;
      if (convId) deleteDraft(convId);
      setActiveReply(null);
      justSentRef.current = true;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSend();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && editingMsgId) {
      e.preventDefault();
      setEditingMsgId(null);
      setEditText('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const handlePickFile = async (file: File) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(`File exceeds the 25 MB limit (${formatFileSize(file.size)}).`, 'error');
      return;
    }
    setIsPreparing(true);
    setSelectedFiles(prev => {
      if (prev.some(f => f.name === file.name && f.size === file.size)) return prev;
      return [...prev, file];
    });
    setPreviewDataUrl(null);
    try {
      if (file.type.startsWith('image/')) {
        const thumb = await generateImageThumbnail(file);
        setPreviewDataUrl(thumb);
      }
    } catch {
      console.error('[Attachment] Thumbnail generation failed');
    } finally {
      setIsPreparing(false);
    }
  };

  const handleFilesChosen = (files: FileList | null) => {
    if (isBlockedDM || !files || files.length === 0) return;
    const fileArray = Array.from(files);
    fileArray.forEach(handlePickFile);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isBlockedDM) return;
    handleFilesChosen(e.dataTransfer.files);
  };

  const startRecording = async () => {
    if (isBlockedDM) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([blob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
        onSendFilesRef.current([file]);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingIntervalRef.current = setInterval(() => setRecordingTime(p => p + 1), 1000);
    } catch (err) {
      console.error('[Voice] Mic access denied:', err);
      setMicDenied(true);
      setTimeout(() => setMicDenied(false), 4000);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    setIsRecording(false);
    setRecordingTime(0);
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingTime(0);
  };

  const handleConfirmDeleteForMe = async () => {
    if (!pendingDeleteForMeId) return;
    onDeleteForMe?.(pendingDeleteForMeId);
    setPendingDeleteForMeId(null);
  };

  const handleConfirmDeleteEveryone = () => {
    if (!pendingDeleteEveryoneId) return;
    onDeleteForEveryone?.(pendingDeleteEveryoneId);
    setPendingDeleteEveryoneId(null);
  };

  const handleStartReply = (msg: LocalMessage) => {
    const senderName = msg.senderId === currentUserId
      ? 'You'
      : selectedUser
      ? selectedUser.fullName || selectedUser.username
      : userLookup.get(msg.senderId) || msg.senderId;
    setActiveReply({ msgId: msg.id, senderName, text: msg.text });
    textareaRef.current?.focus();
  };

  const handleStartEdit = (msg: LocalMessage) => {
    setEditingMsgId(msg.id);
    setEditText(msg.text);
  };

  const handleSaveEdit = (msgId: string) => {
    if (editText.trim()) {
      onEditMessage(msgId, editText.trim());
    }
    setEditingMsgId(null);
  };

  const isAnnouncementChannel = selectedChannel?.isAnnouncement || false;
  const userRole = currentUserKeys?.role || 'MEMBER';
  const isBlockedDM = !!(selectedUser && (blockedUsers.has(selectedUser.userId) || selectedUser.blockedByThem));
  const disabled = !selectedUser && !selectedChannel;
  const isReadOnly = isAnnouncementChannel && userRole === 'MEMBER';
  const canSend = !disabled && !isPreparing && !isReadOnly && !isBlockedDM && (text.trim() || selectedFiles.length > 0);
  const placeholderText = disabled ? 'Select a conversation to start messaging...' : isBlockedDM ? (selectedUser?.blockedByThem ? 'This user blocked you...' : 'You blocked this user...') : 'Type a message...';

  if (!selectedUser && !selectedChannel) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[var(--bg-app)] text-[var(--text-muted)] p-8">
        <div className="w-16 h-16 rounded-2xl bg-[var(--bg-surface)] flex items-center justify-center mb-4 border border-[var(--border-color)]">
          <Shield className="w-8 h-8 text-[var(--text-muted)]" />
        </div>
        <p className="text-sm font-mono">Select a channel or team conversation to start end-to-end encrypted messaging.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--bg-app)] relative">
      {mitmWarning && (
        <div className="bg-rose-950/90 border-b border-rose-500/80 p-3 text-rose-200 font-mono text-xs flex items-center justify-between space-x-3 z-10">
          <div className="flex items-center space-x-3">
            <ShieldAlert className="w-5 h-5 text-rose-500 animate-bounce flex-shrink-0" />
            <div>
              <p className="font-bold text-rose-400">SECURITY ALERT: USER IDENTITY KEY HAS CHANGED</p>
              <p className="text-[11px] text-slate-300">
                The public key for {selectedUser?.username} does not match the pinned fingerprint.
              </p>
            </div>
          </div>
          {selectedUser && onTrustNewKey && (
            <button
              onClick={() => onTrustNewKey(selectedUser)}
              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-slate-100 font-bold text-xs shadow transition-all shrink-0"
            >
              Trust & Pin New Key
            </button>
          )}
        </div>
      )}

      <header
        className="h-16 px-6 flex items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-surface)] shrink-0 z-10 select-none"
      >
        <div className="flex items-center space-x-3 min-w-0">
          {selectedChannel ? (
            <>
              <div
                onClick={() => onOpenChannelSettings?.(selectedChannel)}
                className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm cursor-pointer transition-smooth flex-shrink-0"
                style={{ backgroundColor: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)', color: 'var(--accent-primary)' }}
              >
                #
              </div>
              <div onClick={() => onOpenChannelSettings?.(selectedChannel)} className="cursor-pointer hover:opacity-80 transition-opacity rounded-lg px-2 py-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="font-bold text-sm" style={{ color: 'var(--text-main)' }}>#{selectedChannel.name}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-bold flex-shrink-0" style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--accent-primary)' }}>
                    {selectedChannel.type.toUpperCase()}
                  </span>
                  {selectedChannel.isAnnouncement && (
                    <span className="text-[8px] px-1.5 py-0.5 rounded font-bold flex items-center gap-1 flex-shrink-0" style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', color: '#f59e0b' }}>
                      <Info className="w-2.5 h-2.5" />READ-ONLY
                    </span>
                  )}
                </div>
                <p className="text-[10px] truncate max-w-xs" style={{ color: 'var(--text-muted)' }}>{selectedChannel.description || 'Channel'}</p>
              </div>
            </>
          ) : selectedUser ? (
            <>
              <div
                className="relative flex-shrink-0 cursor-pointer"
                onClick={() => setShowProfileModal(true)}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs flex-shrink-0"
                  style={{ backgroundColor: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)', color: 'var(--accent-primary)' }}>
                  {selectedUser.username.substring(0, 2).toUpperCase()}
                </div>
                {selectedUser.avatarUrl && (
                  <img
                    src={selectedUser.avatarUrl}
                    alt={selectedUser.username}
                    className="w-9 h-9 rounded-lg absolute inset-0 object-cover"
                    style={{ opacity: 0.9 }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '0.9'; }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
              </div>
              <div className="min-w-0 ml-3 cursor-pointer" onClick={() => setShowProfileModal(true)}>
                <div className="flex items-center space-x-2">
                  <span className="font-semibold text-sm truncate hover:underline" style={{ color: 'var(--text-main)' }}>
                    {selectedUser.fullName || selectedUser.username}
                  </span>
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: selectedUser.isOnline ? (selectedUser.isAway ? '#f59e0b' : '#34d399') : 'var(--text-muted)', boxShadow: selectedUser.isOnline ? (selectedUser.isAway ? '0 0 6px #f59e0b' : '0 0 6px #34d399') : 'none' }} />
                </div>
                <span className="text-[10px] block" style={{ color: 'var(--text-muted)' }}>@{selectedUser.username}</span>
                {typingUsers.length > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] mt-0.5" style={{ color: 'var(--accent-primary)' }}>
                    <div className="flex space-x-1">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
                    <span className="italic">{typingUsers[0]} is typing</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center space-x-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <ShieldCheck className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
              <span className="font-bold">PETROSHIELD WORKSPACE</span>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2">
          {onToggleSidebar && (
            <button onClick={onToggleSidebar} title="Open sidebar" className="md:hidden w-8 h-8 rounded-lg flex items-center justify-center transition-smooth"
              style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-main)'; }} onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
              <Menu className="w-4 h-4" />
            </button>
          )}

          {(selectedUser || selectedChannel) && onOpenSearch && (
            <button onClick={onOpenSearch} title="Search messages (Ctrl+K)" className="w-8 h-8 rounded-lg flex items-center justify-center transition-smooth"
              style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-main)'; }} onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
              <Search className="w-4 h-4" />
            </button>
          )}

          <div className="flex items-center space-x-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: isConnected ? '#34d399' : '#f59e0b', boxShadow: isConnected ? '0 0 6px #34d399' : 'none', animation: !isConnected ? 'pulse-soft 2s infinite' : 'none' }} />
            <span className="hidden sm:inline font-bold">{isConnected ? 'ONLINE' : 'RECONNECTING'}</span>
          </div>

          {(selectedUser || selectedChannel) && (
            <button onClick={onCloseChat} title="Close Conversation" className="w-8 h-8 rounded-lg flex items-center justify-center transition-smooth"
              style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4 font-sans relative">
        {allMessages === undefined ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : allMessages.length === 0 ? (
          <div className="text-center my-12 text-[var(--text-muted)] font-mono text-xs space-y-2">
            <Lock className="w-8 h-8 text-[var(--text-muted)]/40 mx-auto" />
            <p className="text-[var(--text-muted)] font-bold">END-TO-END ENCRYPTED CHANNEL READY</p>
            <p className="text-[11px] text-[var(--text-muted)]/60">
              Messages are encrypted locally using AES-256-GCM before transport.
            </p>
          </div>
        ) : (
          visibleMessages.map(msg => (
            <MessageItem
              key={msg.id}
              msg={msg}
              currentUserId={currentUserId}
              selectedUser={selectedUser}
              selectedChannel={selectedChannel}
              messages={allMessages}
              userLookup={userLookup}
              chatType={selectedChannel ? 'channel' : 'dm'}
              editingMsgId={editingMsgId}
              editText={editText}
              setEditText={setEditText}
              setEditingMsgId={setEditingMsgId}
              handleSaveEdit={handleSaveEdit}
              handleStartReply={handleStartReply}
              handleStartEdit={handleStartEdit}
              setPendingDeleteForMeId={setPendingDeleteForMeId}
              setPendingDeleteEveryoneId={setPendingDeleteEveryoneId}
              resolveKey={resolveMessageKey}
              onImageClick={(url, name) => setActiveLightbox({ url, name })}
              reactions={reactionsMap.get(msg.id) || []}
              onAddReaction={handleAddReaction}
              onRemoveReaction={handleRemoveReaction}
              allUsers={allUsers}
              onForward={setForwardMsg}
              isStarred={starredSet.has(msg.id)}
              onToggleStar={handleToggleStar}
              isForwarded={forwardedSet.has(msg.id)}
            />
          ))
        )}
      </div>

      {/* Scroll to bottom button - positioned at bottom right, above input area */}
      {showScrollDown && allMessages && allMessages.length > 0 && (
        <button
          onClick={() => {
            scrollToBottom(true);
            setShowScrollDown(false);
          }}
          className="absolute bottom-24 right-4 w-9 h-9 rounded-full bg-[var(--bg-card)] border border-[var(--border-color)] shadow-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-surface)] transition-all z-10 animate-[slideUp_0.2s_ease-out]"
          title="Scroll to latest messages"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}

      <div className="mx-4 mb-4">
        {micDenied && (
          <div className="mb-2 px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center space-x-2 animate-slideDown">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span>Microphone access denied. Please allow microphone permission in your browser settings.</span>
          </div>
        )}
        {activeReply && (
          <div className="mb-2 flex items-center justify-between p-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-color)] text-xs">
            <div className="flex items-center space-x-2 truncate">
              <Reply className="w-3.5 h-3.5 text-[var(--accent-primary)] flex-shrink-0" />
              <span className="text-[var(--text-muted)]">Replying to <strong className="text-[var(--text-main)]">{activeReply.senderName}</strong>:</span>
              <span className="truncate text-[var(--text-muted)]">{activeReply.text}</span>
            </div>
            <button
              onClick={() => setActiveReply(null)}
              className="p-1 text-[var(--text-muted)] hover:text-[var(--text-main)] flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {selectedFiles.length > 0 && (
          <div className="mb-2 space-y-2">
            {selectedFiles.map((file, index) => (
              <div key={`${file.name}-${file.size}-${index}`} className="flex items-center space-x-3 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-xl p-2.5 animate-[fadeIn_0.15s_ease-out]">
                {file.type.startsWith('image/') && previewDataUrl ? (
                  <img
                    src={previewDataUrl}
                    alt="thumbnail"
                    className="w-14 h-14 object-cover rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)]"
                  />
                ) : file.type.startsWith('image/') ? (
                  <div className="w-14 h-14 rounded-lg bg-[var(--bg-card)] border border-[var(--border-color)] flex items-center justify-center">
                    <FileText className="w-6 h-6 text-[var(--accent-primary)]" />
                  </div>
                ) : (
                  <div className="w-14 h-14 rounded-lg bg-[var(--bg-card)] border border-[var(--border-color)] flex items-center justify-center">
                    <FileText className="w-6 h-6 text-[var(--accent-primary)]" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-[var(--text-main)] truncate">{file.name}</p>
                  <p className="text-[10px] font-mono text-[var(--text-muted)] mt-0.5">
                    {formatFileSize(file.size)} &middot; AES-256-GCM ENCRYPTED
                  </p>
                  {uploadProgress !== null && index === 0 && (
                    <div className="mt-1 w-full bg-[var(--bg-card)] rounded-full h-1">
                      <div
                        className="bg-[var(--accent-primary)] h-1 rounded-full transition-all"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedFiles(prev => prev.filter((_, i) => i !== index))}
                  className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-all flex-shrink-0"
                  title="Remove file"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          onDragOver={e => { e.preventDefault(); if (!disabled) setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-color)] shadow-lg p-2 flex items-center gap-2 transition-colors ${isDragging ? 'border-[var(--accent-primary)]/70' : ''}`}
        >
{!isBlockedDM && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex-shrink-0 h-10 w-10 flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-card)] active:scale-95 transition-all"
              title="Attach file"
            >
              <Paperclip className="h-5 w-5" />
            </button>
          )}

          {!isReadOnly && !isRecording && !isBlockedDM && (
            <button
              type="button"
              onClick={startRecording}
              className="flex-shrink-0 h-10 w-10 flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-card)] active:scale-95 transition-all"
              title="Record voice message"
            >
              <Mic className="h-5 w-5" />
            </button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => { handleFilesChosen(e.target.files); e.target.value = ''; textareaRef.current?.focus(); }}
          />

          <div className="flex-1 min-w-0">
            {isRecording ? (
              <div className="flex items-center gap-3 py-2.5 px-3">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                <span className="text-sm font-mono text-[var(--text-main)]">
                  {String(Math.floor(recordingTime / 60)).padStart(2, '0')}:{String(recordingTime % 60).padStart(2, '0')}
                </span>
                <button
                  type="button"
                  onClick={cancelRecording}
                  className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                  title="Cancel recording"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : isReadOnly ? (
              <div className="py-2.5 px-3 text-sm text-[var(--text-muted)] italic bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)] text-center">
                Only Admins and Supervisors can post in this announcement channel.
              </div>
            ) : selectedUser && blockedUsers.has(selectedUser.userId) ? (
              <div className="py-2.5 px-3 text-sm italic bg-[var(--bg-card)] rounded-xl border text-center"
                style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}>
                You blocked this user. Unblock to send messages.
              </div>
            ) : selectedUser && selectedUser.blockedByThem ? (
              <div className="py-2.5 px-3 text-sm italic bg-[var(--bg-card)] rounded-xl border text-center"
                style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}>
                This user has blocked you. You cannot send messages.
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                value={text}
                onChange={e => { setText(e.target.value); autoResize(); }}
                onKeyDown={handleKeyDown}
                onInput={autoResize}
                placeholder={placeholderText}
                rows={1}
                className="w-full bg-transparent py-2.5 px-2 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none resize-none min-h-[40px] max-h-32 leading-relaxed items-center"
              />
            )}
          </div>

          {!isReadOnly && (
            isRecording ? (
              <button
                type="button"
                onClick={stopRecording}
                className="flex-shrink-0 h-10 w-10 flex items-center justify-center rounded-xl bg-red-500 hover:bg-red-400 text-white font-bold active:scale-95 transition-all animate-pulse"
                title="Stop recording"
              >
                <Mic className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                className="flex-shrink-0 h-10 w-10 flex items-center justify-center rounded-xl bg-[var(--accent-primary)] hover:opacity-90 text-[var(--accent-text)] font-bold active:scale-95 disabled:opacity-30 transition-all"
                title={canSend ? (selectedFiles.length > 0 ? 'Send file(s)' : 'Send message') : 'Type a message to send'}
              >
                <Send className="h-5 w-5" />
              </button>
            )
          )}
        </form>

        {isDragging && (
          <div className="mt-2 p-4 rounded-xl border-2 border-dashed border-[var(--accent-primary)]/60 bg-[var(--accent-primary)]/5 text-center font-mono text-xs text-[var(--accent-primary)] animate-[fadeIn_0.15s_ease-out]">
            DROP FILE TO ENCRYPT & ATTACH
          </div>
        )}
      </div>

<ImageLightboxModal
          imageUrl={activeLightbox?.url ?? ''}
          isOpen={!!activeLightbox}
          onClose={() => setActiveLightbox(null)}
          fileName={activeLightbox?.name ?? 'Media Preview'}
        />

      {inspectedUser && (
        <ProfileModal
          user={inspectedUser}
          currentUserId={currentUserId}
          onClose={() => setInspectedUser(null)}
          onImageClick={(url, name) => setActiveLightbox({ url, name })}
          isBlocked={blockedUsers.has(inspectedUser.userId)}
          onBlock={async () => {
            await blockUser(inspectedUser.userId);
            const token = localStorage.getItem('petroshield_jwt');
            if (token) await fetch(`${API_BASE}/api/block/${inspectedUser.userId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
            setBlockedUsers(prev => new Set(prev).add(inspectedUser.userId));
            onBlockUser?.(inspectedUser.userId);
          }}
          onUnblock={async () => {
            await unblockUser(inspectedUser.userId);
            const token = localStorage.getItem('petroshield_jwt');
            if (token) await fetch(`${API_BASE}/api/block/${inspectedUser.userId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
            setBlockedUsers(prev => { const next = new Set(prev); next.delete(inspectedUser.userId); return next; });
            onUnblockUser?.(inspectedUser.userId);
          }}
        />
      )}

      {showProfileModal && selectedUser && (
        <ProfileModal
          user={selectedUser}
          currentUserId={currentUserId}
          onClose={() => setShowProfileModal(false)}
          onImageClick={(url, name) => setActiveLightbox({ url, name })}
          isBlocked={blockedUsers.has(selectedUser.userId)}
          onBlock={async () => {
            await blockUser(selectedUser.userId);
            const token = localStorage.getItem('petroshield_jwt');
            if (token) await fetch(`${API_BASE}/api/block/${selectedUser.userId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
            setBlockedUsers(prev => new Set(prev).add(selectedUser.userId));
            onBlockUser?.(selectedUser.userId);
          }}
          onUnblock={async () => {
            await unblockUser(selectedUser.userId);
            const token = localStorage.getItem('petroshield_jwt');
            if (token) await fetch(`${API_BASE}/api/block/${selectedUser.userId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
            setBlockedUsers(prev => { const next = new Set(prev); next.delete(selectedUser.userId); return next; });
            onUnblockUser?.(selectedUser.userId);
          }}
          onJumpToMessage={(messageId) => {
            setShowProfileModal(false);
            // Find message position in allMessages and ensure it's loaded
            const msgIndex = allMessages.findIndex(m => m.id === messageId);
            if (msgIndex >= 0) {
              const nonRemoved = allMessages.filter(m => !m.removed);
              const nonRemovedIndex = nonRemoved.findIndex(m => m.id === messageId);
              const visibleStart = nonRemoved.length - loadCount;
              if (nonRemovedIndex < visibleStart) {
                // Message is outside visible window — increase loadCount
                const needed = nonRemoved.length - nonRemovedIndex + 10;
                setLoadCount(prev => Math.max(prev, needed));
              }
            }
            // Scroll after a tick to let React re-render with new loadCount
            setTimeout(() => {
              const el = document.getElementById(`msg-${messageId}`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const bubble = el.querySelector('[data-bubble]') as HTMLElement;
                const target = bubble || el;
                target.style.transition = 'box-shadow 0.5s ease, background-color 0.5s ease';
                target.style.boxShadow = '0 0 20px 4px var(--accent-primary)';
                target.style.backgroundColor = 'color-mix(in srgb, var(--accent-primary) 8%, transparent)';
                target.style.borderRadius = '12px';
                setTimeout(() => {
                  target.style.boxShadow = 'none';
                  target.style.backgroundColor = 'transparent';
                }, 1500);
              }
            }, 200);
          }}
        />
      )}

      <ConfirmModal
        isOpen={!!pendingDeleteForMeId}
        title="Delete message?"
        description="This message will be deleted for you. Other chat participants will still see it."
        confirmLabel="Delete for me"
        isDangerous={true}
        onConfirm={handleConfirmDeleteForMe}
        onClose={() => setPendingDeleteForMeId(null)}
      />

      <ConfirmModal
        isOpen={!!pendingDeleteEveryoneId}
        title="Delete message?"
        description="This message will be deleted for everyone in this chat. This action cannot be undone."
        confirmLabel="Delete for everyone"
        isDangerous={true}
        onConfirm={handleConfirmDeleteEveryone}
        onClose={() => setPendingDeleteEveryoneId(null)}
      />

      <ForwardModal
        isOpen={!!forwardMsg}
        onClose={() => setForwardMsg(null)}
        onForward={(target) => {
          if (forwardMsg && onForwardMessage) {
            onForwardMessage(forwardMsg.text, target);
          }
        }}
        allUsers={allUsers}
        channels={channels}
        currentUserId={currentUserId}
        messageText={forwardMsg?.text || ''}
      />
    </div>
  );
};
