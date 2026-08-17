import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  initDatabase,
  getUploadsDir,
  shutdownDatabase,
  cleanupOrphanedAttachments,
  insertUser,
  getUserById,
  getUserByIdIncludingDeleted,
  getUserByUsername,
  getAllUsers,
  updateUserVaultKeys,
  rotateUserKeys,
  updateUserRole,
  updateUserProfile,
  updateUserAvatar,
  updateUserPassword,
  updateUserStatus,
  revokeUserKeys,
  deleteUser,
  addChannelMember,
  getChannelMembers,
  removeChannelMember,
  getChannelsForUser,
  getChannelById,
  insertChannel,
  getAllChannels,
  updateChannel,
  deleteChannel,
  upsertChannelKeys,
  getChannelKey,
  getDatabaseSize,
  getUploadsSize,
  insertMessage,
  getDirectMessages,
  getChannelMessages,
  getMessagesForUser,
  markIncomingDelivered,
  updateMessageEdit,
  markMessageDeleted,
  insertAttachment,
  getAttachmentById,
  getAttachmentByMessageId,
  getAttachmentsByMessageIds,
  getMessageById,
  linkAttachmentToMessage,
  getDatabaseStats,
  addReaction,
  removeReaction,
  getReactionsForMessage,
  getReactionsForMessages,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  starMessage,
  unstarMessage,
  getStarredMessages,
  getStarredStatus,
  isUserBlockedBy,
  blockUserOnServer,
  unblockUserOnServer,
  getBlockedUsersOf,
  getBlockedByUsers,
  deleteChannelKeysForUser,
  deleteChannelKeysForChannel,
  getChannelKeysForChannel,
  transferChannelOwnership,
  logAudit,
  getAuditLog,
  blockToken,
  isTokenBlocked,
  cleanupExpiredTokens,
  updateMessageStatus,
  getUndeliveredMessages,
  deleteUndecryptableMessages,
  getMembersWithoutKeyEnvelope,
  type DbUser,
  type DbChannel,
  type DbMessage,
} from './db/index.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

// ── Security Configuration ────────────────────────────────────────────────────
const JWT_SECRET: string = process.env.JWT_SECRET!;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET environment variable is required (min 32 chars).');
  process.exit(1);
}
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Token blocklist — PostgreSQL-backed (persistent across restarts)
// Rate limiting for key rotation: Map<userId, timestamps[]>
const rotationsByUser = new Map<string, number[]>();
// Rate limiting for uploads: Map<userId, timestamps[]>
const uploadsByUser = new Map<string, number[]>();
// Slow mode tracker: Map<"slowmode:channelId:userId", lastMsgTimestamp>
const slowModeTracker = new Map<string, number>();
const SLOWMODE_MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes max slow mode

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  maxHttpBufferSize: MAX_ATTACHMENT_BYTES + 1024 * 1024,
});

// ── JWT Helpers ────────────────────────────────────────────────────────────────

// L7: Sanitize user input for log output (prevent log injection)
function sanitizeLog(input: string | undefined | null): string {
  if (!input) return '';
  return String(input).replace(/[\r\n\t]/g, '_').slice(0, 128);
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64UrlDecode(str: string): string {
  let b = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Buffer.from(b, 'base64').toString('utf8');
}
function signJwt(payload: object): string {
  const now = Date.now();
  const withExpiry = { ...payload, iat: now, exp: now + JWT_EXPIRY_MS };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(withExpiry));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}
async function verifyJwt(token: string): Promise<any> {
  try {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    if (await isTokenBlocked(tokenHash)) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const decoded = JSON.parse(base64UrlDecode(payload));
    if (decoded.exp && Date.now() > decoded.exp) return null;
    return decoded;
  } catch { return null; }
}
async function requireAuth(req: express.Request, res: express.Response): Promise<string | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const decoded = await verifyJwt(auth.split(' ')[1]);
  if (!decoded?.userId) { res.status(401).json({ error: 'Invalid token' }); return null; }
  return decoded.userId as string;
}

async function requireAdmin(req: express.Request, res: express.Response): Promise<string | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const decoded = await verifyJwt(auth.split(' ')[1]);
  if (!decoded?.userId) { res.status(401).json({ error: 'Invalid token' }); return null; }
  // Re-verify role from database — don't trust JWT claim
  const user = await getUserById(decoded.userId).catch(() => undefined);
  if (!user || user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return decoded.userId as string;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type UserRole = 'ADMIN' | 'SUPERVISOR' | 'MEMBER';

interface ActiveUser {
  userId: string;
  username: string;
  fullName: string;
  email: string;
  role: UserRole;
  avatarUrl?: string;
  socketId: string;
  publicKey: string;
  lastSeen: number;  // timestamp of last activity (heartbeat, send, etc.)
}

export interface AttachmentPayload {
  attachmentId: string;
  encryptedMetadata: string; // AES-GCM ciphertext of AttachmentMeta JSON
  iv: string;                // IV used for the metadata ciphertext
  binaryIv: string;          // IV used for the encrypted binary payload
}

interface StoredMessage {
  id: string;
  tempId?: string;
  senderId: string;
  recipientId?: string;
  channelId?: string;
  ciphertext: string;
  iv: string;
  timestamp: number;
  status?: string;
  isEdited?: boolean;
  isDeleted?: boolean;
  replyTo?: string;
  attachment?: AttachmentPayload;
}

// ── Runtime (volatile) Presence State — the rest lives in PostgreSQL ──────────
// activeUsers: userId -> Map<socketId, ActiveUser> (supports multiple tabs/connections)
const activeUsers = new Map<string, Map<string, ActiveUser>>();
const socketToUser = new Map<string, string>();              // socketId -> userId
const userToSockets = new Map<string, Set<string>>();        // userId -> Set<socketId>

// Helper to get first active connection for a user (for DM delivery, typing, etc.)
function getPrimarySocket(userId: string): string | undefined {
  const conns = activeUsers.get(userId);
  if (!conns || conns.size === 0) return undefined;
  return conns.keys().next().value;
}

// Helper to check if user has any active connections
function isUserOnline(userId: string): boolean {
  const conns = activeUsers.get(userId);
  return conns !== undefined && conns.size > 0;
}

// Helper to get all online userIds
function getOnlineUserIds(): string[] {
  const online: string[] = [];
  for (const [userId, conns] of activeUsers) {
    if (conns.size > 0) online.push(userId);
  }
  return online;
}

// Helper to build presence list from activeUsers
function buildPresenceList(): { userId: string; isOnline: true; isAway: boolean; lastSeen: number }[] {
  const now = Date.now();
  const presence: { userId: string; isOnline: true; isAway: boolean; lastSeen: number }[] = [];
  for (const [userId, conns] of activeUsers) {
    if (conns.size === 0) continue;
    // Use the most recent lastSeen across all connections
    let latestSeen = 0;
    for (const conn of conns.values()) {
      if (conn.lastSeen > latestSeen) latestSeen = conn.lastSeen;
    }
    presence.push({
      userId,
      isOnline: true,
      isAway: (now - latestSeen) > 5 * 60 * 1000,
      lastSeen: latestSeen,
    });
  }
  return presence;
}

// Broadcast current presence to all connected clients
function broadcastPresence(): void {
  const presence = buildPresenceList();
  io.emit('users:presence', presence);
}

// ── Message Row Mappers ────────────────────────────────────────────────────────

function toDbMessage(payload: StoredMessage): DbMessage {
  return {
    id: payload.id,
    tempId: payload.tempId,
    senderId: payload.senderId,
    recipientId: payload.recipientId,
    channelId: payload.channelId,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    status: payload.status || 'sent',
    isEdited: payload.isEdited,
    isDeleted: payload.isDeleted,
    replyTo: payload.replyTo,
    createdAt: payload.timestamp,
  };
}

function toApiMessage(m: DbMessage): StoredMessage {
  return {
    id: m.id,
    tempId: m.tempId,
    senderId: m.senderId,
    recipientId: m.recipientId,
    channelId: m.channelId,
    ciphertext: m.ciphertext,
    iv: m.iv,
    timestamp: m.createdAt,
    status: m.status,
    isEdited: m.isEdited,
    isDeleted: m.isDeleted,
    replyTo: m.replyTo,
  };
}

/** Attach the linked encrypted payload to each stored message in history */
async function enrichMessagesWithAttachments(msgs: DbMessage[]): Promise<StoredMessage[]> {
  const attachments = await getAttachmentsByMessageIds(msgs.map(m => m.id));
  const out: StoredMessage[] = [];
  for (const m of msgs) {
    const api = toApiMessage(m);
    const att = attachments.get(m.id);
    if (att) {
      api.attachment = {
        attachmentId: att.id,
        encryptedMetadata: att.encryptedMetadata,
        iv: att.metadataIv,
        binaryIv: att.iv,
      };
    }
    out.push(api);
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function hashPassword(pwd: string): Promise<string> {
  return bcrypt.hash(pwd, BCRYPT_ROUNDS);
}

async function verifyPassword(pwd: string, hash: string): Promise<boolean> {
  // Check if hash is a legacy SHA-256 hash (64 hex chars, no $ prefix)
  if (hash.length === 64 && !hash.startsWith('$')) {
    // Legacy SHA-256 hash — use timing-safe comparison
    const legacyHash = crypto.createHash('sha256').update(pwd).digest('hex');
    const hashBuf = Buffer.from(legacyHash, 'hex');
    const storedBuf = Buffer.from(hash, 'hex');
    if (hashBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, storedBuf);
  }
  // Modern bcrypt hash
  return bcrypt.compare(pwd, hash);
}

/** Canonical key for a DM pair (order-independent) */
function dmKey(a: string, b: string) {
  return [a, b].sort().join('::');
}

function publicUser(u: DbUser, includePrivate = false) {
  const avatar = u.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent((u.fullName || u.username).trim())}`;
  const base: any = {
    userId:   u.userId,
    username: u.username,
    fullName: u.fullName,
    role:     u.role,
    avatarUrl: avatar,
    avatar:   avatar,
    status:   u.status || 'ACTIVE',
    statusMessage: u.statusMessage,
    publicKey: u.publicKey,
    signingPublicKey: u.signingPublicKey,
    keyVersion: u.keyVersion ?? 1,
    keyRotationSignature: u.keyRotationSignature,
    oldPublicKey: u.oldPublicKey,
    oldSigningPublicKey: u.oldSigningPublicKey,
    createdAt: u.createdAt,
  };
  // Only include sensitive fields for the user themselves or admin views
  if (includePrivate) {
    base.email = u.email;
    base.phone = u.phone;
  }
  return base;
}

async function buildUserDirectory(requestingUserId?: string) {
  const users = await getAllUsers();
  const blockedIds = requestingUserId ? await getBlockedUsersOf(requestingUserId) : [];
  const blockedByIds = requestingUserId ? await getBlockedByUsers(requestingUserId) : [];
  const blockedSet = new Set(blockedIds);
  const blockedBySet = new Set(blockedByIds);
  return users
    .map(u => ({
      ...publicUser(u),
      isOnline: isUserOnline(u.userId),
      socketId: getPrimarySocket(u.userId),
      blockedByMe: blockedSet.has(u.userId),
      blockedByThem: blockedBySet.has(u.userId),
    }))
    .filter(u => u.userId !== requestingUserId); // exclude self from directory
}

function userToActive(data: { userId: string; username: string; fullName?: string; role?: UserRole; publicKey: string; avatarUrl?: string }, socketId: string, regUser?: DbUser): ActiveUser {
  const role: UserRole = (regUser?.role as UserRole) || 'MEMBER';
  const username = regUser?.username || data.username;
  const fullName = regUser?.fullName || data.fullName || username;
  const email = regUser?.email || `${username}@petroshield.internal`;
  const avatarUrl = regUser?.avatarUrl || data.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(fullName.trim())}`;
  const publicKey = regUser?.publicKey || data.publicKey;
  return {
    userId: data.userId,
    username,
    fullName,
    email,
    role,
    avatarUrl,
    socketId,
    publicKey,
    lastSeen: Date.now(),
  };
}

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.get('/api/auth/me', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const pUser = publicUser(user, true);
    return res.json({
      user: { ...pUser, encryptedPrivateKey: user.encryptedPrivateKey, keySalt: user.keySalt },
      avatar: pUser.avatarUrl
    });
  } catch (e) {
    console.error('[Auth] /me error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

const handleProfileUpdate = async (req: any, res: any) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const { fullName, email, avatarUrl, avatar, status, statusMessage, username, phone } = req.body;
    // Input validation
    if (fullName !== undefined && (typeof fullName !== 'string' || fullName.length > 100)) {
      return res.status(400).json({ error: 'Full name must be a string, max 100 characters' });
    }
    if (email !== undefined && (typeof email !== 'string' || email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (phone !== undefined && (typeof phone !== 'string' || phone.length > 20)) {
      return res.status(400).json({ error: 'Phone must be max 20 characters' });
    }
    if (statusMessage !== undefined && (typeof statusMessage !== 'string' || statusMessage.length > 200)) {
      return res.status(400).json({ error: 'Status message max 200 characters' });
    }
    if (username !== undefined) {
      if (typeof username !== 'string' || username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Username must be 3-30 characters' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
      }
      const existing = await getUserByUsername(username).catch(() => undefined);
      if (existing && existing.userId !== userId) {
        return res.status(409).json({ error: 'Username already taken' });
      }
    }
    const finalAvatarUrl = avatarUrl || avatar;
    await updateUserProfile(userId, { fullName, email, avatarUrl: finalAvatarUrl, status, statusMessage, username, phone });
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    io.emit('user:profile-update', { userId, fullName: user.fullName, username: user.username, avatarUrl: user.avatarUrl, status: user.status, statusMessage: user.statusMessage });
    return res.json({ user: publicUser(user, true) });
  } catch (e) {
    console.error('[Profile] Update error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

app.put('/api/auth/profile', handleProfileUpdate);
app.put('/api/user/profile', handleProfileUpdate);

app.post('/api/users/me/avatar', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const { avatarData } = req.body;
    if (!avatarData || !avatarData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid avatar data' });
    }
    // M5: Enforce avatar size limit (~2MB encoded = ~1.5MB raw)
    const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
    const base64Payload = avatarData.split(',')[1] || '';
    const estimatedBytes = Math.ceil(base64Payload.length * 3 / 4);
    if (estimatedBytes > MAX_AVATAR_BYTES) {
      return res.status(413).json({ error: 'Avatar exceeds 2 MB limit' });
    }
    // Store the data URL directly (base64-encoded image)
    await updateUserAvatar(userId, avatarData);
    io.emit('user:profile-update', { userId, avatarUrl: avatarData });
    return res.json({ avatarUrl: avatarData });
  } catch (e) {
    console.error('[Avatar] Upload error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/auth/password', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  try {
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    // Always store new passwords as bcrypt (even if old was SHA-256)
    await updateUserPassword(userId, await hashPassword(newPassword));
    // Invalidate all sessions for this user
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await blockToken(tokenHash, userId, Date.now() + JWT_EXPIRY_MS);
    }
    // Force disconnect all sockets for this user
    const userConns = activeUsers.get(userId);
    if (userConns) {
      for (const socketId of userConns.keys()) {
        io.to(socketId).emit('user:password_changed', { reason: 'Password changed — please log in again' });
      }
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Password change failed' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.split(' ')[1];
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await blockToken(tokenHash, '', Date.now() + JWT_EXPIRY_MS).catch(() => {});
  }
  return res.json({ success: true });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, fullName, email, password, publicKey, signingPublicKey, encryptedPrivateKey, keySalt } = req.body;
  if (!username || !password || !publicKey) {
    return res.status(400).json({ error: 'Username, password, and public key are required.' });
  }

  // M4: Input validation
  const normalized = username.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 32) {
    return res.status(400).json({ error: 'Username must be 3-32 characters.' });
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    return res.status(400).json({ error: 'Username may only contain lowercase letters, numbers, dots, hyphens, underscores.' });
  }

  // M6: Password complexity
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must contain uppercase, lowercase, and a digit.' });
  }

  // Use original case for userId so "Onelylo" and "onelylo" are different accounts
  const userId = `usr_${username.trim().replace(/[^a-zA-Z0-9]/g, '')}`;
  try {
    const existing = await getUserByIdIncludingDeleted(userId);
    if (existing) {
      if (existing.deletedAt) {
        return res.status(400).json({ error: 'Username was deleted and cannot be re-registered.' });
      }
      return res.status(400).json({ error: 'Username already registered.' });
    }
    // Always assign MEMBER role on registration — roles are managed by admins only
    const userRole: UserRole = 'MEMBER';
    const newUser: DbUser = {
      userId,
      username: username.trim(),
      fullName: (fullName || username).trim(),
      email: (email || `${normalized}@petroshield.internal`).trim(),
      role: userRole,
      passwordHash: await hashPassword(password),
      publicKey,
      signingPublicKey,
      encryptedPrivateKey,
      keySalt,
      createdAt: Date.now(),
    };
    await insertUser(newUser);
    const token = signJwt({ userId, username: newUser.username, role: userRole });
    console.log(`[Auth] Registered: ${sanitizeLog(newUser.username)} (${userId}) [${userRole}]`);
    io.emit('user:registered', { user: publicUser(newUser) });
    return res.json({
      token,
      user: { ...publicUser(newUser, true), encryptedPrivateKey, keySalt }
    });
  } catch (e) {
    console.error('[Auth] Register error:', e);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password, publicKey, signingPublicKey, encryptedPrivateKey, keySalt, forceKeyRotation } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  // Use original case for userId lookup (case-sensitive)
  const userId = `usr_${username.trim().replace(/[^a-zA-Z0-9]/g, '')}`;
  try {
    const user = await getUserById(userId);
    if (!user) {
      const tombstone = await getUserByIdIncludingDeleted(userId);
      if (tombstone?.deletedAt) {
        return res.status(403).json({ error: 'Account has been deleted.' });
      }
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    if (!await verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    // Check if account is suspended
    if (user.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact an administrator.' });
    }
    // Security: Migrate legacy SHA-256 passwords to bcrypt
    if (user.passwordHash.length === 64 && !user.passwordHash.startsWith('$')) {
      const newBcryptHash = await hashPassword(password);
      await updateUserPassword(userId, newBcryptHash).catch(() => {});
    }
    // Update vault keys if key rotation requested or missing
    if (forceKeyRotation && publicKey && encryptedPrivateKey && keySalt) {
      await updateUserVaultKeys(userId, publicKey, encryptedPrivateKey, keySalt, signingPublicKey);
      console.log(`[Auth] Key rotation applied for ${username}`);
    } else if (publicKey && !user.publicKey) {
      await updateUserVaultKeys(userId, publicKey, encryptedPrivateKey || '', keySalt || '', signingPublicKey);
    }
    const token = signJwt({ userId, username: user.username, role: user.role });
    console.log(`[Auth] Login: ${sanitizeLog(user.username)} (${userId})`);
    return res.json({
      token,
      user: {
        ...publicUser(user, true),
        encryptedPrivateKey: user.encryptedPrivateKey,
        keySalt: user.keySalt,
      }
    });
  } catch (e) {
    console.error('[Auth] Login error:', e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ── Signed Key Rotation ────────────────────────────────────────────────────────

/**
 * POST /api/auth/rotate-key
 * Client proves it still holds the OLD signing private key by signing the new
 * public keys. Server verifies against the pinned ECDSA signing public key,
 * then bumps key_version and pins the new keys for TOFU chain verification.
 */
app.post('/api/auth/rotate-key', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  // Rate limit: max 3 rotations per hour per user
  const now = Date.now();
  const userRotations = (rotationsByUser.get(userId) || []).filter(t => t > now - 3600000);
  if (userRotations.length >= 3) {
    return res.status(429).json({ error: 'Too many key rotations. Try again in 1 hour.' });
  }
  userRotations.push(now);
  rotationsByUser.set(userId, userRotations);
  const { publicKey, signingPublicKey, encryptedPrivateKey, keySalt, signature, oldPublicKey } = req.body;
  if (!publicKey || !signingPublicKey || !encryptedPrivateKey || !keySalt || !signature || !oldPublicKey) {
    return res.status(400).json({ error: 'publicKey, signingPublicKey, encryptedPrivateKey, keySalt, signature, and oldPublicKey are required.' });
  }
  try {
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.publicKey || !user.signingPublicKey) {
      return res.status(400).json({ error: 'No pinned key to rotate from' });
    }
    if (user.oldPublicKey && user.oldPublicKey !== user.publicKey) {
      return res.status(400).json({ error: 'A rotation is already pending verification' });
    }
    if (user.publicKey !== oldPublicKey) {
      return res.status(409).json({ error: 'Key rotation conflict: server is pinned to a different key' });
    }

    const verifier = crypto.createVerify('SHA256');
    verifier.update(`petroshield-key-rotation-v1\n${publicKey}\n${signingPublicKey}\n${oldPublicKey}`);
    const ok = verifier.verify(
      {
        key: Buffer.from(user.signingPublicKey, 'base64'),
        format: 'der',
        type: 'spki',
        dsaEncoding: 'ieee-p1363',
      },
      signature,
      'base64'
    );
    if (!ok) {
      return res.status(403).json({ error: 'Signature invalid: not signed by the previous private key' });
    }

    await rotateUserKeys(userId, publicKey, encryptedPrivateKey, keySalt, signature, oldPublicKey, signingPublicKey);
    console.log(`[KeyRotation] ${user.username} (${userId}) rotated key → version ${(user.keyVersion ?? 1) + 1}`);
    io.emit('user:key_rotated', {
      userId,
      publicKey,
      signingPublicKey,
      keyVersion: (user.keyVersion ?? 1) + 1,
      keyRotationSignature: signature,
      oldPublicKey,
    });
    return res.json({ success: true, keyVersion: (user.keyVersion ?? 1) + 1 });
  } catch (e) {
    console.error('[KeyRotation] Error:', e);
    return res.status(500).json({ error: 'Key rotation failed' });
  }
});

/**
 * GET /api/users/:id/keys — TOFU fingerprint endpoint.
 * Clients compare the pinned key metadata after every rotation to detect MITM.
 */
app.get('/api/users/:id/keys', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      publicKey: user.publicKey,
      signingPublicKey: user.signingPublicKey,
      keyVersion: user.keyVersion ?? 1,
      keyRotationSignature: user.keyRotationSignature,
      oldPublicKey: user.oldPublicKey,
      oldSigningPublicKey: user.oldSigningPublicKey,
      createdAt: user.createdAt,
    });
  } catch (e) {
    console.error('[Keys] Fetch error:', e);
    return res.status(500).json({ error: 'Key fetch failed' });
  }
});

// ── User Directory Route ──────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    return res.json({ users: await buildUserDirectory(userId) });
  } catch (e) {
    console.error('[Directory] Error:', e);
    return res.status(500).json({ error: 'Directory fetch failed' });
  }
});

// ── Admin RBAC Routes ─────────────────────────────────────────────────────────

app.get('/api/admin/users', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const users = await getAllUsers();
    return res.json({
      users: users.map(u => ({
        ...publicUser(u, true),
        isOnline: activeUsers.has(u.userId),
      })),
    });
  } catch (e) {
    console.error('[Admin] List error:', e);
    return res.status(500).json({ error: 'Admin user list failed' });
  }
});

app.patch('/api/admin/users/:id/role', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const { role } = req.body;
  if (role !== 'ADMIN' && role !== 'SUPERVISOR' && role !== 'MEMBER') {
    return res.status(400).json({ error: 'role must be ADMIN, SUPERVISOR, or MEMBER' });
  }
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.userId === adminId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    // Prevent demoting the last admin
    if (target.role === 'ADMIN' && role !== 'ADMIN') {
      const allUsers = await getAllUsers();
      const adminCount = allUsers.filter(u => u.role === 'ADMIN').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin' });
      }
    }
    await updateUserRole(target.userId, role);
    await logAudit(adminId, 'role_change', 'user', target.userId, `${target.role} -> ${role}`);
    io.emit('user:role_change', { userId: target.userId, role });
    return res.json({ success: true, user: { ...publicUser(target), role } });
  } catch (e) {
    return res.status(500).json({ error: 'Role change failed' });
  }
});

// Admin update user profile fields (fullName, phone)
app.patch('/api/admin/users/:id/profile', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { fullName, phone, email, username } = req.body;
    // Validate username if changing
    if (username && username !== target.username) {
      if (typeof username !== 'string' || username.length < 3 || username.length > 30 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-30 chars, alphanumeric + underscore' });
      }
      const existing = await getUserByUsername(username).catch(() => undefined);
      if (existing && existing.userId !== target.userId) {
        return res.status(409).json({ error: 'Username already taken' });
      }
    }
    await updateUserProfile(target.userId, { fullName, phone, email, username });
    const updated = await getUserById(target.userId);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    io.emit('user:profile-update', { userId: updated.userId, fullName: updated.fullName, username: updated.username, avatarUrl: updated.avatarUrl });
    return res.json({ success: true, user: publicUser(updated, true) });
  } catch (e) {
    return res.status(500).json({ error: 'Profile update failed' });
  }
});

// Admin force password reset
app.patch('/api/admin/users/:id/password', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { newPassword } = req.body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Password must contain uppercase, lowercase, and a digit' });
    }
    await updateUserPassword(target.userId, await hashPassword(newPassword));
    await logAudit(adminId, 'force_password_reset', 'user', target.userId);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Password reset failed' });
  }
});

// Admin revoke E2EE keys
app.patch('/api/admin/users/:id/revoke-keys', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await revokeUserKeys(target.userId);
    await logAudit(adminId, 'key_revocation', 'user', target.userId);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Key revocation failed' });
  }
});

// Admin suspend/activate user
app.patch('/api/admin/users/:id/status', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { status } = req.body;
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE or SUSPENDED' });
    }
    await updateUserStatus(target.userId, status);
    await logAudit(adminId, 'status_change', 'user', target.userId, status);
    // Force disconnect if suspending
    if (status === 'SUSPENDED') {
      const userConns = activeUsers.get(target.userId);
      if (userConns) {
        for (const socketId of userConns.keys()) {
          io.to(socketId).emit('user:suspended', { reason: 'Your account has been suspended' });
        }
      }
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Status update failed' });
  }
});

// Admin audit log
app.get('/api/admin/audit-log', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const entries = await getAuditLog(limit, offset);
    return res.json({ entries });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.userId === adminId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await deleteUser(target.userId);
    await logAudit(adminId, 'user_deleted', 'user', target.userId, target.username);
    console.log(`[Admin] ${adminId} deleted user ${target.username} (${target.userId})`);
    io.emit('user:removed', { userId: target.userId });
    return res.json({ success: true });
  } catch (e) {
    console.error('[Admin] Delete error:', e);
    return res.status(500).json({ error: 'User deletion failed' });
  }
});

// ── Admin Stats Route ─────────────────────────────────────────────────────────

app.get('/api/admin/stats', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const stats = await getDatabaseStats();
    const users = await getAllUsers();
    const onlineCount = users.filter(u => activeUsers.has(u.userId)).length;
    const adminCount = users.filter(u => u.role === 'ADMIN').length;

    return res.json({
      ...stats,
      onlineUsers: onlineCount,
      offlineUsers: stats.users - onlineCount,
      admins: adminCount,
      members: stats.users - adminCount,
      activeSockets: activeUsers.size,
    });
  } catch (e) {
    console.error('[Admin] Stats error:', e);
    return res.status(500).json({ error: 'Admin stats failed' });
  }
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ── Admin Health / Infrastructure Route ───────────────────────────────────────

app.get('/api/admin/health', async (req, res) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    const uptimeSec = process.uptime();
    const mem = process.memoryUsage();
    const dbSize = await getDatabaseSize();
    const uploads = await getUploadsSize();

    return res.json({
      server: {
        uptime: Math.floor(uptimeSec),
        uptimePretty: formatUptime(uptimeSec),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rssPretty: formatBytes(mem.rss),
        heapUsedPretty: formatBytes(mem.heapUsed),
      },
      database: {
        sizeBytes: dbSize.bytes,
        sizePretty: dbSize.pretty,
      },
      storage: {
        uploadsBytes: uploads.bytes,
        uploadsPretty: uploads.pretty,
        fileCount: uploads.fileCount,
      },
    });
  } catch (e) {
    console.error('[Admin] Health error:', e);
    return res.status(500).json({ error: 'Admin health failed' });
  }
});

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Message History Routes ────────────────────────────────────────────────────

app.get('/api/messages/direct/:recipientId', async (req, res) => {
  const senderId = await requireAuth(req, res);
  if (!senderId) return;
  try {
    const msgs = await getDirectMessages(senderId, req.params.recipientId);
    await markIncomingDelivered(senderId);
    return res.json({ messages: await enrichMessagesWithAttachments(msgs) });
  } catch (e) {
    console.error('[History] DM fetch error:', e);
    return res.status(500).json({ error: 'History fetch failed' });
  }
});

/**
 * Full chat history for the requesting user (DM threads + every channel).
 * Used on login / after server restart to instantly restore the conversation feed.
 */
app.get('/api/messages', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const msgs = await getMessagesForUser(userId);
    await markIncomingDelivered(userId);
    return res.json({ messages: await enrichMessagesWithAttachments(msgs) });
  } catch (e) {
    console.error('[History] Global fetch error:', e);
    return res.status(500).json({ error: 'History fetch failed' });
  }
});

// ── Reactions Batch Endpoint ────────────────────────────────────────────────
app.post('/api/reactions/batch', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds array required' });
  }
  try {
    const reactions = await getReactionsForMessages(messageIds);
    return res.json({ reactions });
  } catch (e) {
    console.error('[Reactions] Batch fetch error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── URL Preview Endpoint ───────────────────────────────────────────────────────
app.get('/api/url-preview', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Only HTTP(S) URLs allowed' });

    // SSRF protection: resolve DNS FIRST, then check resolved IPs
    const hostname = parsed.hostname;
    const isPrivateIP = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/i.test(hostname)
      || /^(::1|fc00:|fd00:|fe80:|ff00:|::ffff:(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.))/i.test(hostname)
      || hostname === 'localhost';
    if (isPrivateIP) return res.status(400).json({ error: 'Private/internal URLs not allowed' });

    // Resolve DNS and check for private IPs (prevents DNS rebinding TOCTOU)
    const dns = await import('dns').catch(() => null);
    if (dns) {
      const resolved = await new Promise<string[]>((resolve) => {
        dns.resolve4(hostname, (err, addresses) => {
          if (err || !addresses) resolve([]);
          else resolve(addresses);
        });
      });
      for (const ip of resolved) {
        if (/^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/i.test(ip)) {
          return res.status(400).json({ error: 'Resolved to private IP' });
        }
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PetroShield/1.0)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return res.json({ url, title: null, description: null, image: null });

    const html = await response.text();
    // Extract OG tags
    const getMeta = (property: string): string | null => {
      const match = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`, 'i'));
      return match?.[1] || null;
    };

    const title = getMeta('og:title') || getMeta('twitter:title')
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || null;
    const description = getMeta('og:description') || getMeta('twitter:description') || getMeta('description') || null;
    const image = getMeta('og:image') || getMeta('twitter:image') || null;

    return res.json({ url, title: title?.slice(0, 200), description: description?.slice(0, 300), image: image?.slice(0, 500) });
  } catch (e) {
    return res.json({ url, title: null, description: null, image: null });
  }
});

// ── Starred Messages ──────────────────────────────────────────────────────────
app.post('/api/starred', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: 'messageId required' });
  try {
    await starMessage(userId, messageId);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[Starred] Error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/starred/:messageId', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    await unstarMessage(userId, req.params.messageId);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[Unstarred] Error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/starred', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const starred = await getStarredMessages(userId);
    return res.json({ starred });
  } catch (e) {
    console.error('[Starred] Fetch error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/starred/batch', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds array required' });
  }
  try {
    const status = await getStarredStatus(userId, messageIds);
    return res.json({ status });
  } catch (e) {
    console.error('[Starred] Batch error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Block/Unblock Endpoints ────────────────────────────────────────────────────

app.post('/api/block/:userId', async (req, res) => {
  const blockerId = await requireAuth(req, res);
  if (!blockerId) return;
  const { userId: blockedId } = req.params;
  if (blockerId === blockedId) return res.status(400).json({ error: 'Cannot block yourself' });
  try {
    await blockUserOnServer(blockerId, blockedId);
    // Push updated directory to the blocked user so they see blockedByThem
    const userConns = activeUsers.get(blockedId);
    if (userConns) {
      const directory = await buildUserDirectory(blockedId);
      for (const socketId of userConns.keys()) {
        io.to(socketId).emit('users:directory', directory);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/block/:userId', async (req, res) => {
  const blockerId = await requireAuth(req, res);
  if (!blockerId) return;
  const { userId: blockedId } = req.params;
  try {
    await unblockUserOnServer(blockerId, blockedId);
    // Push updated directory to the unblocked user so they see blockedByThem is gone
    const userConns = activeUsers.get(blockedId);
    if (userConns) {
      const directory = await buildUserDirectory(blockedId);
      for (const socketId of userConns.keys()) {
        io.to(socketId).emit('users:directory', directory);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/block/status/:userId', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { userId: targetId } = req.params;
  try {
    const blockedByThem = await isUserBlockedBy(userId, targetId);
    const blockedByTarget = await isUserBlockedBy(targetId, userId);
    return res.json({ blockedByThem, blockedByTarget });
  } catch (e) {
    console.error('[Block] Status error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Cleanup undecryptable messages ──────────────────────────────────────────
app.post('/api/messages/cleanup', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const deleted = await deleteUndecryptableMessages();
    return res.json({ deleted });
  } catch (e) {
    console.error('[Cleanup] Error:', e);
    return res.status(500).json({ error: 'Cleanup failed' });
  }
});

// ── Get members missing key envelopes for a channel ─────────────────────────
app.get('/api/channels/:channelId/missing-keys', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { channelId } = req.params;
  try {
    const members = await getMembersWithoutKeyEnvelope(channelId);
    return res.json({ members });
  } catch (e) {
    console.error('[ChannelKeys] Missing keys error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Channel Keys Endpoints (Key Distribution) ─────────────────────────────────

app.post('/api/channels/:channelId/keys', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  const { channelId } = req.params;
  const { keys } = req.body; // Array of { userId, encryptedChannelKey, iv }

  if (!Array.isArray(keys)) {
    return res.status(400).json({ error: 'keys array required' });
  }
  try {
    // M10: Verify uploader is a channel member
    const members = await getChannelMembers(channelId);
    const isMember = members.includes(userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a channel member' });
    }
    // For official channels, store envelopes for ALL users (they auto-join).
    // For private/team channels, only store for actual members (prevents key leakage).
    const channel = await getChannelById(channelId);
    const isOpen = channel && channel.type === 'official';
    const memberSet = new Set(members);
    const filteredKeys = isOpen
      ? keys.filter((item: any) => item.userId && item.encryptedChannelKey && item.iv)
      : keys.filter((item: any) => item.userId && item.encryptedChannelKey && item.iv && memberSet.has(item.userId));
    const droppedKeys = keys.filter((item: any) => !item.userId || !item.encryptedChannelKey || !item.iv || (!isOpen && !memberSet.has(item.userId)));
    if (droppedKeys.length > 0) {
      console.warn(`[ChannelKeys] Dropped ${droppedKeys.length} envelope(s) for non-members:`, droppedKeys.map((k: any) => k.userId));
    }
    const validKeys = filteredKeys.map((item: any) => ({
        channelId,
        userId: item.userId,
        encryptedChannelKey: item.encryptedChannelKey,
        iv: item.iv,
      }));
    await upsertChannelKeys(channelId, validKeys);
    console.log(`[ChannelKeys] Stored ${validKeys.length} envelope(s) for channel ${channelId} (requested ${keys.length})`);

    return res.json({ success: true, count: validKeys.length });
  } catch (e) {
    console.error('[ChannelKeys] Store error:', e);
    return res.status(500).json({ error: 'Failed to store channel keys' });
  }
});

app.get('/api/channels/:channelId/key', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const keyEntry = await getChannelKey(req.params.channelId, userId);
    if (!keyEntry) {
      return res.status(404).json({ error: 'No channel key envelope found for user' });
    }
    return res.json({ key: keyEntry });
  } catch (e) {
    console.error('[ChannelKeys] Fetch error:', e);
    return res.status(500).json({ error: 'Channel key fetch failed' });
  }
});

// ── Channel Management (Admin/Manager) ─────────────────────────────────────────

app.patch('/api/channels/:channelId', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const channel = await getChannelById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    // Check permissions: ADMIN can update any channel; SUPERVISOR/MEMBER can only update channels they created
    const user = await getUserById(userId);
    if (!user) return res.status(403).json({ error: 'User not found' });
    if (user.role !== 'ADMIN' && channel.createdBy !== userId) {
      return res.status(403).json({ error: 'Insufficient permissions to modify this channel' });
    }
    
    const { name, description, isAnnouncement, allowedRoles, memberIds, slowModeSeconds } = req.body;

    // Detect new/removed members BEFORE mutation
    const currentMemberIds = channel.memberIds || [];
    const newMembers = memberIds ? memberIds.filter((id: string) => !currentMemberIds.includes(id)) : [];

    const { removedMembers } = await updateChannel(req.params.channelId, { name, description, isAnnouncement, allowedRoles, memberIds, slowModeSeconds });

    const updated = await getChannelById(req.params.channelId);
    await broadcastChannels();

    // Emit member-specific events for real-time sidebar updates
    if (memberIds) {
      for (const memberId of newMembers) {
        // Auto-join new member to channel room if they're online (all their connections)
        const userConns = activeUsers.get(memberId);
        if (userConns) {
          for (const socketId of userConns.keys()) {
            io.to(socketId).socketsJoin(`channel:${req.params.channelId}`);
          }
        }
        io.emit('channel:member_added', { channelId: req.params.channelId, userId: memberId });
      }
      for (const memberId of removedMembers) {
        // Remove from channel room (all their connections)
        const userConns = activeUsers.get(memberId);
        if (userConns) {
          for (const socketId of userConns.keys()) {
            io.to(socketId).socketsLeave(`channel:${req.params.channelId}`);
          }
        }
        io.emit('channel:member_removed', { channelId: req.params.channelId, userId: memberId });
      }
      // Security: Notify remaining members that channel key needs rotation
      if (removedMembers.length > 0) {
        io.emit('channel:key_rotated', { channelId: req.params.channelId, removedMemberIds: removedMembers });
      }
    }
    
    return res.json({ channel: updated });
  } catch (e) {
    console.error('[Channel] Update error:', e);
    return res.status(500).json({ error: 'Failed to update channel' });
  }
});

app.delete('/api/channels/:channelId', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const channel = await getChannelById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    // Check permissions: only ADMIN or channel creator can delete
    const user = await getUserById(userId);
    if (!user || (user.role !== 'ADMIN' && channel.createdBy !== userId)) {
      return res.status(403).json({ error: 'Insufficient permissions to delete this channel' });
    }
    
    await deleteChannel(req.params.channelId);
    await broadcastChannels();
    return res.json({ success: true });
  } catch (e) {
    console.error('[Channel] Delete error:', e);
    return res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// ── Attachment Endpoints (Zero-Knowledge) ─────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/', 'video/', 'audio/', 'application/pdf',
      'application/zip', 'application/x-7z-compressed', 'application/gzip',
      'text/plain', 'application/octet-stream',
    ];
    const ok = allowed.some(prefix => file.mimetype.startsWith(prefix));
    if (!ok) return cb(new Error('File type not allowed'));
    cb(null, true);
  },
});

/**
 * POST /api/attachments/upload — the server only ever sees the *encrypted*
 * binary payload + encrypted metadata blob. It stores the bytes to disk and a
 * row in `attachments`; it never possesses decryption keys or plaintext.
 */
app.post('/api/attachments/upload', upload.single('file'), async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  // Rate limit: max 10 uploads per minute per user
  const now = Date.now();
  const userUploads = (uploadsByUser.get(userId) || []).filter(t => t > now - 60000);
  if (userUploads.length >= 10) {
    return res.status(429).json({ error: 'Too many uploads. Try again in 1 minute.' });
  }
  userUploads.push(now);
  uploadsByUser.set(userId, userUploads);
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { encryptedMetadata, binaryIv, metadataIv } = req.body;
    if (!encryptedMetadata || !binaryIv) {
      return res.status(400).json({ error: 'Missing encrypted metadata or binary IV' });
    }
    // L8: Validate metadata field lengths to prevent abuse
    if (typeof encryptedMetadata !== 'string' || encryptedMetadata.length > 100000) {
      return res.status(400).json({ error: 'Invalid encrypted metadata' });
    }
    if (typeof binaryIv !== 'string' || binaryIv.length > 256) {
      return res.status(400).json({ error: 'Invalid binary IV' });
    }
    if (metadataIv && (typeof metadataIv !== 'string' || metadataIv.length > 256)) {
      return res.status(400).json({ error: 'Invalid metadata IV' });
    }
    const attachmentId = `att_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const diskName = `${attachmentId}.enc`;
    const absPath = path.join(getUploadsDir(), diskName);
    await fs.promises.writeFile(absPath, req.file.buffer);

    await insertAttachment({
      id: attachmentId,
      messageId: null,
      filePath: diskName,
      encryptedMetadata,
      iv: binaryIv,
      metadataIv: metadataIv || '',
      createdAt: Date.now(),
    });

    return res.json({ attachmentId });
  } catch (e) {
    console.error('[Attachment] Upload error:', e);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * GET /api/attachments/:id — streams the encrypted binary payload.
 * Client-side WebCrypto decrypts it locally; server never sees plaintext.
 */
app.get('/api/attachments/:id', async (req, res) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;
  try {
    const attachment = await getAttachmentById(req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    if (attachment.messageId) {
      const msg = await getMessageById(attachment.messageId);
      if (msg) {
        if (msg.channelId) {
          // Channel attachment: verify user is a channel member
          const members = await getChannelMembers(msg.channelId);
          if (!members.includes(userId)) return res.status(403).json({ error: 'Not a channel member' });
        } else if (msg.senderId !== userId && msg.recipientId !== userId) {
          return res.status(403).json({ error: 'Not a participant of this message' });
        }
      }
    } else {
      // Unlinked attachment (messageId=null): only allow the original uploader
      // We check by looking at who uploaded it — stored as metadata in the encrypted blob.
      // For safety, deny unlinked attachment access to prevent auth bypass.
      return res.status(403).json({ error: 'Unlinked attachment not downloadable' });
    }

    const uploadsDir = path.resolve(getUploadsDir());
    const abs = path.resolve(path.join(uploadsDir, attachment.filePath));
    if (!abs.startsWith(uploadsDir)) return res.status(400).json({ error: 'Invalid file path' });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(abs);
  } catch (e) {
    console.error('[Attachment] Download error:', e);
    return res.status(500).json({ error: 'Download failed' });
  }
});

// ── Health Route ──────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    // M8: Health endpoint requires admin auth in production
    if (IS_PRODUCTION) {
      const userId = await requireAuth(req, res);
      if (!userId) return;
      const user = await getUserById(userId);
      if (!user || user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin access required' });
      }
    }
    const stats = await getDatabaseStats();
    res.json({
      status: 'ok',
      database: 'postgres',
      users: stats.users,
      channels: stats.channels,
      messages: stats.messages,
      attachments: stats.attachments,
      activeUsers: activeUsers.size,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: IS_PRODUCTION ? 'Internal error' : (e as Error).message });
  }
});

// ── Orphaned Attachment Cleanup (every 30 minutes) ──────────────────────────
setInterval(async () => {
  try {
    const { count, filePaths } = await cleanupOrphanedAttachments();
    for (const filePath of filePaths) {
      const absPath = path.join(getUploadsDir(), filePath);
      await fs.promises.unlink(absPath).catch(() => {});
    }
    if (count > 0) {
      console.log(`[Cleanup] Removed ${count} orphaned attachment(s)`);
    }
  } catch (e) {
    console.error('[Cleanup] Orphaned attachment cleanup error:', e);
  }
}, 30 * 60 * 1000);

// ── Error Handler (multer limits, etc.) ───────────────────────────────────────

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds 25 MB limit' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Upload error' });
  }
  console.error('[Express] Unhandled error:', err);
  return res.status(500).json({ error: IS_PRODUCTION ? 'Server error' : err?.message || 'Server error' });
});

// ── Socket Events ─────────────────────────────────────────────────────────────

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  const decoded = await verifyJwt(token as string);
  if (!decoded?.userId) {
    return next(new Error('Invalid or expired token'));
  }
  // Check if user is suspended
  const user = await getUserById(decoded.userId).catch(() => undefined);
  if (user?.status === 'SUSPENDED') {
    return next(new Error('Account suspended'));
  }
  // Attach authenticated userId to socket for downstream use
  (socket as any).authenticatedUserId = decoded.userId;
  next();
});

// Broadcast per-user filtered channel lists (respects private/team membership)
async function broadcastChannels(): Promise<void> {
  for (const [userId, userConns] of activeUsers) {
    try {
      const filtered = await getAllChannels(userId);
      // Auto-join ALL sockets to official channel rooms they aren't in yet
      for (const [socketId, user] of userConns) {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) {
          for (const ch of filtered) {
            if (ch.type === 'official') {
              sock.join(`channel:${ch.id}`);
            }
          }
        }
        io.to(socketId).emit('channels:update', filtered);
      }
    } catch (e) {
      console.error('[Channel] Broadcast error for user:', e);
    }
  }
}

io.on('connection', (socket) => {

  // Simple per-socket rate limiter for message sends
  const msgTimestamps: number[] = [];
  const isRateLimited = (): boolean => {
    const now = Date.now();
    // Remove timestamps older than 1 second
    while (msgTimestamps.length > 0 && msgTimestamps[0] < now - 1000) msgTimestamps.shift();
    // Allow max 10 messages per second
    if (msgTimestamps.length >= 10) return true;
    msgTimestamps.push(now);
    return false;
  };

  // Rate limiter for reactions (10 per 10 seconds)
  const reactionTimestamps: number[] = [];
  const isReactionRateLimited = (): boolean => {
    const now = Date.now();
    while (reactionTimestamps.length > 0 && reactionTimestamps[0] < now - 10000) reactionTimestamps.shift();
    if (reactionTimestamps.length >= 10) return true;
    reactionTimestamps.push(now);
    return false;
  };

  // Rate limiter for channel creates (1 per 30 seconds)
  const channelCreateTimestamps: number[] = [];
  const isChannelCreateRateLimited = (): boolean => {
    const now = Date.now();
    while (channelCreateTimestamps.length > 0 && channelCreateTimestamps[0] < now - 30000) channelCreateTimestamps.shift();
    if (channelCreateTimestamps.length >= 1) return true;
    channelCreateTimestamps.push(now);
    return false;
  };

  // Rate limiter for typing indicators (2 per second)
  const typingTimestamps: number[] = [];
  const isTypingRateLimited = (): boolean => {
    const now = Date.now();
    while (typingTimestamps.length > 0 && typingTimestamps[0] < now - 1000) typingTimestamps.shift();
    if (typingTimestamps.length >= 2) return true;
    typingTimestamps.push(now);
    return false;
  };

  socket.on('user:join', async (data: { userId: string; username: string; fullName?: string; role?: UserRole; publicKey: string; signingPublicKey?: string }) => {
    // Verify the claimed userId matches the authenticated socket user
    const authenticatedUserId = (socket as any).authenticatedUserId;
    if (data.userId !== authenticatedUserId) {
      console.warn(`[Socket] userId mismatch: claimed ${data.userId}, authenticated ${authenticatedUserId}`);
      return;
    }
    // Always use DB-resolved role, never trust client-supplied role (H7)
    const regUser = await getUserById(data.userId).catch(() => undefined);
    const activeUser = userToActive(data, socket.id, regUser);

    // Track this connection
    let userConns = activeUsers.get(data.userId);
    const isFirstConnection = !userConns || userConns.size === 0;
    if (!userConns) {
      userConns = new Map();
      activeUsers.set(data.userId, userConns);
    }
    userConns.set(socket.id, activeUser);

    // Track socket mappings
    socketToUser.set(socket.id, data.userId);
    let userSockets = userToSockets.get(data.userId);
    if (!userSockets) {
      userSockets = new Set();
      userToSockets.set(data.userId, userSockets);
    }
    userSockets.add(socket.id);

    // Store username on socket for typing indicators
    (socket as any).username = data.username;

    // If this is the user's FIRST connection, broadcast online status
    if (isFirstConnection) {
      // Broadcast the new user's full data to ALL other connected clients FIRST
      // so they have the public key for E2EE decryption before channel:member_added fires
      const fullUser = {
        userId: activeUser.userId,
        username: activeUser.username,
        fullName: activeUser.fullName,
        role: activeUser.role,
        avatarUrl: activeUser.avatarUrl,
        publicKey: activeUser.publicKey,
        isOnline: true,
      };
      socket.broadcast.emit('user:online', fullUser);
      io.emit('user:status_change', { userId: data.userId, isOnline: true, isAway: false, at: Date.now() });
    }

    // Send full user directory (excluding self) to joining user
    const directory = await buildUserDirectory(data.userId).catch(() => []);
    socket.emit('users:directory', directory);

    // Auto-join user to ALL channels they should see (official + member-of)
    try {
      const allCh = await getAllChannels(data.userId).catch(() => []);
      const memberOf = await getChannelsForUser(data.userId).catch(() => []);
      const memberIds = new Set(memberOf.map(c => c.id));
      for (const ch of allCh) {
        socket.join(`channel:${ch.id}`);
        // Auto-add as member for official channels
        if (!memberIds.has(ch.id) && ch.type === 'official') {
          await addChannelMember(ch.id, data.userId, 'system').catch(() => {});
          // Notify existing members so they distribute the channel key to this user
          io.emit('channel:member_added', { channelId: ch.id, userId: data.userId });
        }
      }
    } catch {}

    // Broadcast updated presence list to everyone (includes isAway for inactive users)
    broadcastPresence();

    // Send channel list (persisted in PostgreSQL) — filtered per-user
    const channels = await getAllChannels(data.userId).catch(() => []);
socket.emit('channels:update', channels);

    // Send undelivered DM messages that were sent while user was offline
    const undelivered = await getUndeliveredMessages(data.userId).catch(() => []);
    for (const msg of undelivered) {
      // Fetch attachment for undelivered messages
      const attachment = await getAttachmentByMessageId(msg.id).catch(() => undefined);
      socket.emit('message:receive', {
        ...msg,
        status: 'sent',
        timestamp: msg.createdAt,
        attachment: attachment ? {
          attachmentId: attachment.id,
          encryptedMetadata: attachment.encryptedMetadata,
          iv: attachment.metadataIv,
          binaryIv: attachment.iv,
        } : undefined,
      });
    }

  });

  // Channel CRUD
  socket.on('channel:create', async (data: { name: string; description: string; type: 'official' | 'team' | 'private'; isAnnouncement?: boolean; allowedRoles?: string[]; memberIds?: string[] }) => {
    const authenticatedUserId = (socket as any).authenticatedUserId;
    if (!authenticatedUserId) return;
    if (isChannelCreateRateLimited()) return;
    // Permission check: only ADMIN can create official/announcement channels
    const userConns = activeUsers.get(authenticatedUserId);
    const creatorRole = userConns?.values().next().value?.role || 'MEMBER';
    if ((data.type === 'official' || data.isAnnouncement) && creatorRole !== 'ADMIN') {
      return;
    }
    
    const channelId = data.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const channels = await getAllChannels().catch(() => []);
    if (channels.some(c => c.id === channelId)) return;
    const newChannel: DbChannel = {
      id: channelId,
      name: data.name.toLowerCase(),
      description: data.description,
      type: data.type,
      createdBy: authenticatedUserId,
      createdAt: Date.now(),
      isAnnouncement: data.isAnnouncement || false,
      allowedRoles: data.allowedRoles || ['ADMIN', 'SUPERVISOR', 'MEMBER'],
    };
    await insertChannel(newChannel).catch(e => console.error('[Channel] Persist error:', e));
    // Add creator to channel_members so they can see the channel
    await addChannelMember(channelId, authenticatedUserId, authenticatedUserId).catch(() => {});
    // Add invited members and join their sockets to the channel room
    const invitedIds = (data.memberIds || []).filter(mid => mid !== authenticatedUserId);
    for (const mid of invitedIds) {
      await addChannelMember(channelId, mid, authenticatedUserId).catch(() => {});
      // Join invited member's socket to channel room if online (all their connections)
      const userConns = activeUsers.get(mid);
      if (userConns) {
        for (const socketId of userConns.keys()) {
          io.to(socketId).socketsJoin(`channel:${channelId}`);
        }
      }
    }
    // Auto-join creator to channel room
    socket.join(`channel:${channelId}`);

    console.log(`[Channel] Created ${channelId} by ${authenticatedUserId} with ${invitedIds.length} invited member(s)`);
    await broadcastChannels();

    // ACK to creator so client knows channel is ready for key distribution
    socket.emit('channel:create:ack', { channelId });
  });

  socket.on('channels:get', async () => {
    const uid = (socket as any).authenticatedUserId;
    const channels = await getAllChannels(uid).catch(() => []);
    socket.emit('channels:update', channels);
  });

  // Channel Join — user enters a channel room to receive messages
  socket.on('channel:join', async (data: { channelId: string }) => {
    const userId = (socket as any).authenticatedUserId;
    if (!userId) return;
    const { channelId } = data;
    try {
      const channel = await getChannelById(channelId);
      if (!channel) return;
      let members = await getChannelMembers(channelId);
      // For official channels, auto-add the user as a member if not already
      if (channel.type === 'official' && !members.includes(userId)) {
        await addChannelMember(channelId, userId, 'system').catch(() => {});
        members = [...members, userId];
        io.emit('channel:member_added', { channelId, userId });
      }
      if (!members.includes(userId)) return;
      socket.join(`channel:${channelId}`);
      // Send current channel members to the joining user
      const memberUsers = await Promise.all(members.map(mid => getUserById(mid).catch(() => undefined)));
      socket.emit('channel:members', { channelId, members: memberUsers.filter((u): u is DbUser => !!u).map(u => publicUser(u)) });
    } catch (e) {
      console.error('[Channel] Join error:', e);
    }
  });

  // Channel Leave — user quits a team/private channel
  socket.on('channel:leave', async (data: { channelId: string }) => {
    const userId = (socket as any).authenticatedUserId;
    if (!userId) return;
    const { channelId } = data;
    try {
      const channel = await getChannelById(channelId);
      if (!channel) return;
      // Only team and private channels can be left
      if (channel.type !== 'team' && channel.type !== 'private') return;
      const members = await getChannelMembers(channelId);
      if (!members.includes(userId)) return;

      // If the owner is leaving, delegate ownership to the next member
      let updatedChannel = channel;
      if (channel.createdBy === userId) {
        const otherMembers = members.filter(m => m !== userId);
        if (otherMembers.length > 0) {
          const newOwnerId = otherMembers[0];
          await transferChannelOwnership(channelId, newOwnerId);
          updatedChannel = { ...channel, createdBy: newOwnerId };
          io.emit('channel:ownership_transferred', { channelId, fromUserId: userId, toUserId: newOwnerId });
        }
      }

      // Remove the user
      await removeChannelMember(channelId, userId);
      // Delete their channel key
      await deleteChannelKeysForUser(channelId, userId);
      // Remove from channel room
      socket.leave(`channel:${channelId}`);
      // Notify everyone
      io.emit('channel:member_removed', { channelId, userId });
      io.emit('channel:key_rotated', { channelId, removedMemberIds: [userId] });
      await broadcastChannels();
    } catch (e) {
      console.error('[Channel] Leave error:', e);
    }
  });

  // Channel Key Request — user can't decrypt, asks online members to distribute key
  socket.on('channel:key:request', async (data: { channelId: string }) => {
    const userId = (socket as any).authenticatedUserId;
    if (!userId || !data.channelId) return;
    // Verify requester is a member
    const members: string[] = await getChannelMembers(data.channelId).catch(() => []);
    if (!members.includes(userId)) return;
    console.log(`[ChannelKey] User ${userId} requested key for channel ${data.channelId}`);
    // Notify all other members in the channel room so they can distribute
    socket.to(`channel:${data.channelId}`).emit('channel:key_request', { channelId: data.channelId, requesterId: userId });
  });

  // Direct Message Send — persisted to PostgreSQL
  socket.on('message:send', async (payload: StoredMessage) => {
    if (isRateLimited()) return;
    const authenticatedUserId = (socket as any).authenticatedUserId;
    const { recipientId, ciphertext, tempId, id, attachment } = payload;
    if (typeof ciphertext !== 'string') {
      socket.emit('message:ack', { tempId: tempId || id, serverId: id || `srv_${Date.now()}`, timestamp: Date.now(), status: 'failed', error: 'Invalid message format.' });
      return;
    }
    // Allow empty ciphertext only if there is an attachment (attachment-only message)
    if (!ciphertext && !attachment?.attachmentId) {
      socket.emit('message:ack', { tempId: tempId || id, serverId: id || `srv_${Date.now()}`, timestamp: Date.now(), status: 'failed', error: 'Message has no content.' });
      return;
    }
    // Security: Message length limit (10KB ciphertext max)
    if (ciphertext.length > 10240) {
      socket.emit('message:ack', { tempId: tempId || id, serverId: id || `srv_${Date.now()}`, timestamp: Date.now(), status: 'failed' });
      return;
    }
    // Verify senderId matches authenticated user (prevent spoofing)
    const senderId = authenticatedUserId;

    // Check if either party has blocked the other
    if (recipientId) {
      const blockedByRecipient = await isUserBlockedBy(recipientId, senderId);
      const blockedBySender = await isUserBlockedBy(senderId, recipientId);
      if (blockedByRecipient || blockedBySender) {
        socket.emit('message:ack', {
          tempId: tempId || id,
          serverId: id || `srv_${Date.now()}`,
          timestamp: Date.now(),
          status: 'failed',
        });
        return;
      }
    }

    const messageId = id || `srv_${Date.now()}`;

    try {
      await insertMessage(toDbMessage({ ...payload, senderId, id: messageId, status: 'sent', timestamp: payload.timestamp ?? Date.now() }));
    } catch (e) {
      console.error('[DM] Persist error:', e);
    }

    // Link attachment separately so a failure doesn't block the message
    if (attachment?.attachmentId) {
      try {
        await linkAttachmentToMessage(attachment.attachmentId, messageId);
      } catch (e) {
        console.error('[DM] linkAttachmentToMessage failed:', e);
      }
    }

    // ACK to sender
    socket.emit('message:ack', {
      tempId: tempId || messageId,
      serverId: messageId,
      timestamp: Date.now(),
      status: 'sent',
    });

    // Relay to recipient if online
    if (recipientId) {
      const userConns = activeUsers.get(recipientId);
      if (userConns) {
        const relayPayload = { ...payload, senderId, id: messageId, status: 'sent', timestamp: payload.timestamp ?? Date.now() };
        if (payload.attachment) {
          relayPayload.attachment = payload.attachment;
        } else {
          // Fallback: fetch attachment from database if not in payload
          const dbAttachment = await getAttachmentByMessageId(messageId).catch(() => undefined);
          if (dbAttachment) {
            relayPayload.attachment = {
              attachmentId: dbAttachment.id,
              encryptedMetadata: dbAttachment.encryptedMetadata,
              iv: dbAttachment.metadataIv,
              binaryIv: dbAttachment.iv,
            };
          }
        }
        for (const socketId of userConns.keys()) {
          io.to(socketId).emit('message:receive', relayPayload);
        }

      } else {

      }
    }
  });

  // Group Channel Message Send — persisted to PostgreSQL
  socket.on('channel:message:send', async (payload: StoredMessage) => {
    if (isRateLimited()) return;
    const authenticatedUserId = (socket as any).authenticatedUserId;
    const { channelId, ciphertext, tempId, id, attachment } = payload;
    if (!channelId) {
      socket.emit('message:ack', { tempId: tempId || id, serverId: id || `srv_${Date.now()}`, timestamp: Date.now(), status: 'failed', error: 'Missing channel ID.' });
      return;
    }
    if (typeof ciphertext !== 'string') {
      socket.emit('message:ack', { tempId: tempId || id, serverId: id || `srv_${Date.now()}`, timestamp: Date.now(), status: 'failed', error: 'Invalid message format.' });
      return;
    }
    // Allow empty ciphertext only if there is an attachment (attachment-only message)
    if (!ciphertext && !attachment?.attachmentId) {
      socket.emit('message:ack', { tempId: tempId || id, serverId: id || `srv_${Date.now()}`, timestamp: Date.now(), status: 'failed', error: 'Message has no content.' });
      return;
    }
    // Security: Message length limit (10KB ciphertext max)
    if (ciphertext.length > 10240) {
      socket.emit('message:ack', { tempId: tempId || id, serverId: id || `srv_${Date.now()}`, timestamp: Date.now(), status: 'failed' });
      return;
    }
    const senderId = authenticatedUserId;
    const messageId = id || `srv_${Date.now()}`;

    // Check channel exists and membership
    const channel = await getChannelById(channelId);
    if (!channel) {
      socket.emit('message:ack', { tempId: tempId || messageId, serverId: messageId, timestamp: Date.now(), status: 'failed', error: 'Channel not found' });
      return;
    }

    // Security: Check membership for ALL channel types
    const members = await getChannelMembers(channelId);
    if (!members.includes(senderId)) {
      socket.emit('message:ack', { tempId: tempId || messageId, serverId: messageId, timestamp: Date.now(), status: 'failed', error: 'You are not a member of this channel.' });
      return;
    }

    // Security: Check allowedRoles
    if (channel.allowedRoles && channel.allowedRoles.length > 0) {
      const userConns = activeUsers.get(senderId);
      const senderRole = userConns?.values().next().value?.role || 'MEMBER';
      if (!channel.allowedRoles.includes(senderRole)) {
        socket.emit('message:ack', { tempId: tempId || messageId, serverId: messageId, timestamp: Date.now(), status: 'failed', error: 'You do not have permission to post in this channel.' });
        return;
      }
    }

    // Permission check for announcement channels: only ADMIN and SUPERVISOR can post
    if (channel.isAnnouncement) {
      const userConns = activeUsers.get(senderId);
      const senderRole = userConns?.values().next().value?.role || 'MEMBER';
      if (senderRole === 'MEMBER') {
        socket.emit('message:ack', {
          tempId: tempId || messageId,
          serverId: messageId,
          timestamp: Date.now(),
          status: 'failed',
          error: 'Only Admins and Supervisors can post in official announcement channels.'
        });
        return;
      }
    }

    // Slow mode enforcement
    if (channel && (channel.slowModeSeconds || 0) > 0) {
      const lastMsgKey = `slowmode:${channelId}:${senderId}`;
      const lastMsgTime = slowModeTracker.get(lastMsgKey);
      if (lastMsgTime) {
        const elapsed = (Date.now() - lastMsgTime) / 1000;
        const slowSec = channel.slowModeSeconds || 0;
        if (elapsed < slowSec) {
          const waitSec = Math.ceil(slowSec - elapsed);
          socket.emit('message:ack', {
            tempId: tempId || messageId,
            serverId: messageId,
            timestamp: Date.now(),
            status: 'failed',
            error: `Slow mode: wait ${waitSec}s before sending again.`
          });
          return;
        }
      }
      slowModeTracker.set(lastMsgKey, Date.now());
    }

    try {
      await insertMessage(toDbMessage({ ...payload, senderId, id: messageId, status: 'sent', timestamp: payload.timestamp ?? Date.now() }));
    } catch (e) {
      console.error('[Channel] Persist error:', e);
    }

    // Link attachment separately so a failure doesn't block the message
    if (attachment?.attachmentId) {
      try {
        await linkAttachmentToMessage(attachment.attachmentId, messageId);
      } catch (e) {
        console.error('[Channel] linkAttachmentToMessage failed:', e);
      }
    }

    // ACK
    socket.emit('message:ack', {
      tempId: tempId || messageId,
      serverId: messageId,
      timestamp: Date.now(),
      status: 'sent',
    });

    // Broadcast to channel members only (room-based delivery)
    let channelRelayPayload = { ...payload, senderId, id: messageId, status: 'sent', timestamp: payload.timestamp ?? Date.now() };
    if (!payload.attachment) {
      const dbAttachment = await getAttachmentByMessageId(messageId).catch(() => undefined);
      if (dbAttachment) {
        channelRelayPayload.attachment = {
          attachmentId: dbAttachment.id,
          encryptedMetadata: dbAttachment.encryptedMetadata,
          iv: dbAttachment.metadataIv,
          binaryIv: dbAttachment.iv,
        };
      }
    }
    socket.to(`channel:${channelId}`).emit('channel:message:receive', channelRelayPayload);
  });

  // Delivery receipt: Recipient device saved message ➔ Notify sender of delivery
  socket.on('message:delivered', async (data: { messageId: string; tempId?: string; senderId?: string; channelId?: string }) => {
    if (data.channelId) {
      // Channel message: look up the original sender from DB and notify them
      const msg = await getMessageById(data.messageId).catch(() => undefined);
      if (msg?.senderId) {
        const userConns = activeUsers.get(msg.senderId);
        if (userConns) {
          for (const socketId of userConns.keys()) {
            io.to(socketId).emit('message:delivered_ack', { id: data.messageId, tempId: data.tempId });
          }
        }
      }
    } else if (data.senderId) {
      // DM: notify the original sender directly (all their connections)
      const userConns = activeUsers.get(data.senderId);
      if (userConns) {
        for (const socketId of userConns.keys()) {
          io.to(socketId).emit('message:delivered_ack', { id: data.messageId, tempId: data.tempId });
        }
      }
    }
    // Update message status in database
    await updateMessageStatus(data.messageId, 'delivered').catch(() => {});
  });

  // Read receipt: Recipient opened active conversation thread ➔ Notify sender(s) of read status
  socket.on('message:read', async (data: { conversationId: string; senderId?: string; lastReadMessageId?: string }) => {
    if (data.senderId) {
      // DM: notify the specific sender (all their connections)
      const userConns = activeUsers.get(data.senderId);
      if (userConns) {
        for (const socketId of userConns.keys()) {
          io.to(socketId).emit('message:read_ack', { conversationId: data.conversationId, lastReadMessageId: data.lastReadMessageId });
        }
      }
    } else {
      // Channel: broadcast read receipt to ALL online members of that channel
      socket.to(`channel:${data.conversationId}`).emit('message:read_ack', {
        conversationId: data.conversationId,
        lastReadMessageId: data.lastReadMessageId,
        readBy: (socket as any).authenticatedUserId,
      });
    }
    // Update message status in database — mark all messages up to lastReadMessageId as read
    if (data.lastReadMessageId) {
      await updateMessageStatus(data.lastReadMessageId, 'read').catch(() => {});
    }
  });

  // Message Edit — with authorization check (H3)
  socket.on('message:edit', async (data: { id: string; newCiphertext: string; newIv: string; recipientId?: string; channelId?: string }) => {
    const authenticatedUserId = (socket as any).authenticatedUserId;
    const originalMsg = await getMessageById(data.id).catch(() => undefined);
    if (!originalMsg || originalMsg.senderId !== authenticatedUserId) {
      socket.emit('message:edit:rejected', { id: data.id, error: 'Unauthorized: you can only edit your own messages' });
      return;
    }
    await updateMessageEdit(data.id, data.newCiphertext, data.newIv).catch(() => {});
    if (data.recipientId) {
      const userConns = activeUsers.get(data.recipientId);
      if (userConns) {
        for (const socketId of userConns.keys()) {
          io.to(socketId).emit('message:edited', { id: data.id, newCiphertext: data.newCiphertext, newIv: data.newIv, editedAt: Date.now() });
        }
      }
    } else if (data.channelId) {
      socket.to(`channel:${data.channelId}`).emit('message:edited', { id: data.id, newCiphertext: data.newCiphertext, newIv: data.newIv, editedAt: Date.now() });
    }
  });

  // Message Delete — with authorization check (H3)
  socket.on('message:delete', async (data: { id: string; recipientId?: string; channelId?: string }) => {
    const authenticatedUserId = (socket as any).authenticatedUserId;
    const originalMsg = await getMessageById(data.id).catch(() => undefined);
    if (!originalMsg || originalMsg.senderId !== authenticatedUserId) {
      socket.emit('message:delete:rejected', { id: data.id, error: 'Unauthorized' });
      return;
    }
    await markMessageDeleted(data.id).catch(() => {});
    if (data.recipientId) {
      const userConns = activeUsers.get(data.recipientId);
      if (userConns) {
        for (const socketId of userConns.keys()) {
          io.to(socketId).emit('message:deleted', { id: data.id, deletedForEveryone: true });
        }
      }
    } else if (data.channelId) {
      socket.to(`channel:${data.channelId}`).emit('message:deleted', { id: data.id, deletedForEveryone: true });
    }
  });

  // Reactions — verify message exists and user has access
  socket.on('reaction:add', async (data: { messageId: string; emoji: string }) => {
    const userId = (socket as any).authenticatedUserId;
    if (!userId) return;
    if (isReactionRateLimited()) return;
    const msg = await getMessageById(data.messageId).catch(() => undefined);
    if (!msg) return;
    if (msg.channelId) {
      const members: string[] = await getChannelMembers(msg.channelId).catch(() => []);
      if (!members.includes(userId)) return;
    } else if (msg.recipientId) {
      if (msg.senderId !== userId && msg.recipientId !== userId) return;
    }
    try {
      await addReaction(data.messageId, userId, data.emoji);
      const reactions = await getReactionsForMessage(data.messageId).catch(() => []);
      io.emit('message:reactions', { messageId: data.messageId, reactions });
    } catch (e) {
      // Only log, don't broadcast stale data that would overwrite optimistic update
      console.error('[Reaction] Add failed:', e);
    }
  });

  socket.on('reaction:remove', async (data: { messageId: string; emoji: string }) => {
    const userId = (socket as any).authenticatedUserId;
    if (!userId) return;
    if (isReactionRateLimited()) return;
    const msg = await getMessageById(data.messageId).catch(() => undefined);
    if (!msg) return;
    if (msg.channelId) {
      const members: string[] = await getChannelMembers(msg.channelId).catch(() => []);
      if (!members.includes(userId)) return;
    } else if (msg.recipientId) {
      if (msg.senderId !== userId && msg.recipientId !== userId) return;
    }
    try {
      await removeReaction(data.messageId, userId, data.emoji);
      const reactions = await getReactionsForMessage(data.messageId).catch(() => []);
      io.emit('message:reactions', { messageId: data.messageId, reactions });
    } catch (e) {
      console.error('[Reaction] Remove failed:', e);
    }
  });

  // Message Pinning — verify channel membership
  socket.on('message:pin', async (data: { channelId: string; messageId: string }) => {
    const userId = (socket as any).authenticatedUserId;
    if (!userId) return;
    // Security: Verify channel membership
    const members: string[] = await getChannelMembers(data.channelId).catch(() => []);
    if (!members.includes(userId)) return;
    await pinMessage(data.channelId, data.messageId, userId).catch(() => {});
    const pinned = await getPinnedMessages(data.channelId).catch(() => []);
    socket.to(`channel:${data.channelId}`).emit('channel:pinned', { channelId: data.channelId, pinned });
  });

  socket.on('message:unpin', async (data: { channelId: string; messageId: string }) => {
    const userId = (socket as any).authenticatedUserId;
    if (!userId) return;
    const members: string[] = await getChannelMembers(data.channelId).catch(() => []);
    if (!members.includes(userId)) return;
    await unpinMessage(data.channelId, data.messageId).catch(() => {});
    const pinned = await getPinnedMessages(data.channelId).catch(() => []);
    socket.to(`channel:${data.channelId}`).emit('channel:pinned', { channelId: data.channelId, pinned });
  });

  // Typing Indicators — use authenticated user, never trust client-supplied userId/username
  socket.on('user:typing', (data: { channelId?: string; recipientId?: string }) => {
    const authenticatedUserId = (socket as any).authenticatedUserId;
    if (!authenticatedUserId) return;
    if (isTypingRateLimited()) return;
    const userData = { userId: authenticatedUserId, username: (socket as any).username || authenticatedUserId, channelId: data.channelId, recipientId: data.recipientId };
    if (data.channelId) {
      socket.to(`channel:${data.channelId}`).emit('user:typing', userData);
    } else if (data.recipientId) {
      const recipientSocketId = getPrimarySocket(data.recipientId);
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('user:typing', userData);
      }
    }
  });

  socket.on('user:stop_typing', (data: { channelId?: string; recipientId?: string }) => {
    const authenticatedUserId = (socket as any).authenticatedUserId;
    if (!authenticatedUserId) return;
    const userData = { userId: authenticatedUserId, username: (socket as any).username || authenticatedUserId, channelId: data.channelId, recipientId: data.recipientId };
    if (data.channelId) {
      socket.to(`channel:${data.channelId}`).emit('user:stop_typing', userData);
    } else if (data.recipientId) {
      const recipientSocketId = getPrimarySocket(data.recipientId);
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('user:stop_typing', userData);
      }
    }
  });

  // Presence heartbeat — client sends every 60s, updates lastSeen timestamp
  socket.on('user:heartbeat', () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      const userConns = activeUsers.get(userId);
      if (userConns) {
        const conn = userConns.get(socket.id);
        if (conn) {
          conn.lastSeen = Date.now();
        }
      }
    }
  });

  socket.on('disconnect', () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      const userConns = activeUsers.get(userId);
      let lastSeen = Date.now();
      let username = userId;
      if (userConns) {
        const conn = userConns.get(socket.id);
        if (conn) {
          lastSeen = conn.lastSeen || Date.now();
          username = conn.username || userId;
        }
        // Remove this specific connection
        userConns.delete(socket.id);
        // If no more connections, user is fully offline
        const isLastConnection = userConns.size === 0;
        if (isLastConnection) {
          activeUsers.delete(userId);
        }
      }
      // Clean up socket mappings
      socketToUser.delete(socket.id);
      const userSockets = userToSockets.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          userToSockets.delete(userId);
        }
      }
      console.log(`[Registry] Disconnected: ${username} (${userId}), remaining connections: ${userConns?.size ?? 0}`);

      // If this was the last connection, broadcast offline status
      const userConnsAfter = activeUsers.get(userId);
      if (!userConnsAfter || userConnsAfter.size === 0) {
        io.emit('user:status_change', { userId, isOnline: false, isAway: true, at: lastSeen });
      }
      // Always broadcast updated presence
      broadcastPresence();
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

async function boot() {
  try {
    await initDatabase();
  } catch (e) {
    console.error('[Boot] Failed to initialise PostgreSQL:', e);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`\n================================================`);
    console.log(`  PetroShield Enterprise E2EE — Port ${PORT}`);
    console.log(`  Roles: ADMIN | SUPERVISOR | MEMBER`);
    console.log(`  Database: PostgreSQL (persistent)`);
    console.log(`  APIs: /api/users  /api/messages  /api/messages/direct/:id`);
    console.log(`  Attachments: /api/attachments/upload | /api/attachments/:id`);
    console.log(`================================================\n`);

    // Periodic cleanup: expired tokens, stale slowmode entries, empty rate limit maps
    setInterval(() => {
      cleanupExpiredTokens().catch(() => {});
      const now = Date.now();
      for (const [key, ts] of slowModeTracker) {
        if (now - ts > SLOWMODE_MAX_DURATION_MS) slowModeTracker.delete(key);
      }
      for (const [key, timestamps] of rotationsByUser) {
        const fresh = timestamps.filter(t => t > now - 3600000);
        if (fresh.length === 0) rotationsByUser.delete(key);
        else rotationsByUser.set(key, fresh);
      }
      for (const [key, timestamps] of uploadsByUser) {
        const fresh = timestamps.filter(t => t > now - 60000);
        if (fresh.length === 0) uploadsByUser.delete(key);
        else uploadsByUser.set(key, fresh);
      }
    }, 5 * 60 * 1000);

    // Periodic cleanup: stale activeUsers (no heartbeat for 3 minutes)
    setInterval(() => {
      const now = Date.now();
      const staleThreshold = 3 * 60 * 1000;
      let removedUsers = 0;
      let removedConnections = 0;
      for (const [userId, userConns] of activeUsers) {
        // Remove stale connections
        for (const [socketId, conn] of userConns) {
          if (now - conn.lastSeen > staleThreshold) {
            console.log(`[Registry] Removing stale connection for ${conn.username || userId} (socket: ${socketId}), lastSeen ${Math.round((now - conn.lastSeen) / 1000)}s ago`);
            userConns.delete(socketId);
            socketToUser.delete(socketId);
            const userSockets = userToSockets.get(userId);
            if (userSockets) {
              userSockets.delete(socketId);
              if (userSockets.size === 0) userToSockets.delete(userId);
            }
            removedConnections++;
          }
        }
        // If no more connections, remove user entirely
        if (userConns.size === 0) {
          activeUsers.delete(userId);
          removedUsers++;
        }
      }
      if (removedUsers > 0 || removedConnections > 0) {
        broadcastPresence();
        console.log(`[Registry] Cleanup: removed ${removedConnections} stale connection(s), ${removedUsers} fully offline user(s)`);
      }
    }, 60 * 1000);
  });
}

async function gracefulShutdown() {
  console.log('\n[Shutdown] Stopping PostgreSQL & server…');
  await shutdownDatabase();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

boot();
