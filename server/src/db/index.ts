/**
 * PetroShield PostgreSQL Persistence Layer
 * Uses `embedded-postgres` to run a real, file-backed PostgreSQL 18 cluster
 * locally (data survives server restarts). All application state lives in the
 * `postgres` database defined by `schema.sql` — no in-memory state stores.
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const { Pool } = pg;

// ── Embedded Cluster Configuration ──────────────────────────────────────────

const DB_DIR = process.env.VAULTCHAT_PGDATA || path.join(__dirname, '..', '..', '.pgdata');
const DB_PORT = Number(process.env.VAULTCHAT_PGPORT || 5433);
const DB_USER = process.env.VAULTCHAT_PGUSER || 'petroshield';
const DB_PASS = process.env.VAULTCHAT_PGPASSWORD || crypto.randomBytes(16).toString('hex');
const UPLOADS_DIR = process.env.PETROSHIELD_UPLOADS || path.join(__dirname, '..', '..', 'uploads');

let pool: pg.Pool | null = null;
let embedded: EmbeddedPostgres | null = null;

// ── Row Types (snake_case ⟷ camelCase mapping) ──────────────────────────────

export interface DbUser {
  userId: string;
  username: string;
  fullName: string;
  email: string;
  role: string;
  passwordHash: string;
  publicKey: string;
  encryptedPrivateKey?: string;
  keySalt?: string;
  keyVersion?: number;
  keyRotationSignature?: string;
  oldPublicKey?: string;
  signingPublicKey?: string;
  oldSigningPublicKey?: string;
  avatarUrl?: string;
  status?: string;
  statusMessage?: string;
  phone?: string;
  deletedAt?: number | null;
  createdAt: number;
}

export interface DbChannel {
  id: string;
  name: string;
  description: string;
  type: 'official' | 'team' | 'private';
  createdBy: string;
  createdAt: number;
  isAnnouncement?: boolean;
  allowedRoles?: string[];
  memberIds?: string[];
  slowModeSeconds?: number;
}

export interface DbChannelKey {
  channelId: string;
  userId: string;
  encryptedChannelKey: string;
  iv: string;
}

export interface DbMessage {
  id: string;
  tempId?: string;
  senderId: string;
  recipientId?: string;
  channelId?: string;
  ciphertext: string;
  iv: string;
  status: string;
  isEdited?: boolean;
  isDeleted?: boolean;
  replyTo?: string;
  createdAt: number;
}

export interface DbAttachment {
  id: string;
  messageId?: string | null;
  filePath: string;
  encryptedMetadata: string;
  iv: string;        // IV for the encrypted binary payload
  metadataIv: string; // IV for the encrypted metadata JSON
  createdAt: number;
}

// ── Boot ────────────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<pg.Pool> {
  if (pool) return pool;

  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  embedded = new EmbeddedPostgres({
    databaseDir: DB_DIR,
    user: DB_USER,
    password: DB_PASS,
    port: DB_PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=en_US.UTF-8'],
  });

  const isInitialised = fs.existsSync(path.join(DB_DIR, 'PG_VERSION'));
  if (!isInitialised) {
    console.log('[DB] Initialising PostgreSQL data directory…');
    await embedded.initialise();
  }

  try {
    await embedded.start();
  } catch (err) {
    // A leftover Postgres process may already hold the port from a crashed run.
    const reason = err && typeof err === 'object' ? (err as Error).message || String(err) : String(err);
    console.warn('[DB] Embedded Postgres start failed (likely already running):', reason);
  }

  pool = new Pool({
    host: '127.0.0.1',
    port: DB_PORT,
    database: 'postgres',
    user: DB_USER,
    password: DB_PASS,
    max: 10,
  });

  await runSchema();
  await seedDefaultChannels();
  await seedAdminAccount();

  return pool;
}

async function runSchema(): Promise<void> {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await getPool().query(schema);
  console.log('[DB] Schema verified (users, channels, channel_keys, channel_members, messages, attachments)');
}

export function getUploadsDir(): string {
  return UPLOADS_DIR;
}

async function seedDefaultChannels(): Promise<void> {
  // Migrate any existing 'public' channels to 'official'
  await getPool().query(`UPDATE channels SET type = 'official' WHERE type = 'public'`).catch(() => {});
}

async function seedAdminAccount(): Promise<void> {
  const username = 'Onelylo';
  const userId = `usr_${username.replace(/[^a-zA-Z0-9]/g, '')}`;

  // Check if admin already exists by id OR username
  const existingById = await getPool().query('SELECT id FROM users WHERE id = $1', [userId]);
  const existingByName = await getPool().query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  if (existingById.rows.length > 0 || existingByName.rows.length > 0) return;

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn('[DB] ADMIN_PASSWORD not set — skipping admin seed');
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const createdAt = Date.now();

  await getPool().query(
    `INSERT INTO users (id, username, full_name, email, role, password_hash, public_key, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, username, 'Onelylo', 'admin@petroshield.local', 'ADMIN', passwordHash, '', 'ACTIVE', createdAt]
  );
  console.log(`[DB] Seeded admin account: ${username} (${userId})`);
}

function getPool(): pg.Pool {
  if (!pool) throw new Error('Database not initialised — call initDatabase() first');
  return pool;
}

// ── Users ───────────────────────────────────────────────────────────────────

const USER_COLS = 'id, username, full_name, email, role, password_hash, public_key, encrypted_private_key, key_salt, key_version, key_rotation_signature, old_public_key, signing_public_key, old_signing_public_key, avatar_url, status, status_message, phone, deleted_at, created_at';
const USER_COLS_SAFE = 'id, username, full_name, email, role, public_key, encrypted_private_key, key_salt, key_version, key_rotation_signature, old_public_key, signing_public_key, old_signing_public_key, avatar_url, status, status_message, phone, deleted_at, created_at';

function mapUserRow(row: any): DbUser {
  return {
    userId: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
    publicKey: row.public_key,
    encryptedPrivateKey: row.encrypted_private_key,
    keySalt: row.key_salt,
    keyVersion: row.key_version,
    keyRotationSignature: row.key_rotation_signature,
    oldPublicKey: row.old_public_key,
    signingPublicKey: row.signing_public_key,
    oldSigningPublicKey: row.old_signing_public_key,
    avatarUrl: row.avatar_url || undefined,
    status: row.status || 'ACTIVE',
    statusMessage: row.status_message || undefined,
    phone: row.phone || undefined,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
    createdAt: Number(row.created_at),
  };
}

export async function insertUser(user: DbUser): Promise<void> {
  await getPool().query(
    `INSERT INTO users (id, username, full_name, email, role, password_hash, public_key, encrypted_private_key, key_salt, key_version, signing_public_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [user.userId, user.username, user.fullName, user.email, user.role, user.passwordHash, user.publicKey, user.encryptedPrivateKey ?? null, user.keySalt ?? null, user.keyVersion ?? 1, user.signingPublicKey ?? null, user.createdAt]
  );
}

export async function getUserById(userId: string): Promise<DbUser | undefined> {
  const res = await getPool().query(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  return res.rows[0] ? mapUserRow(res.rows[0]) : undefined;
}

export async function getUserByIdIncludingDeleted(userId: string): Promise<DbUser | undefined> {
  const res = await getPool().query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId]);
  return res.rows[0] ? mapUserRow(res.rows[0]) : undefined;
}

export async function getUserByUsername(username: string): Promise<DbUser | undefined> {
  const res = await getPool().query(`SELECT ${USER_COLS} FROM users WHERE username = $1 AND deleted_at IS NULL`, [username]);
  return res.rows[0] ? mapUserRow(res.rows[0]) : undefined;
}

export async function getAllUsers(): Promise<DbUser[]> {
  const res = await getPool().query(`SELECT ${USER_COLS_SAFE} FROM users WHERE deleted_at IS NULL ORDER BY username ASC`);
  return res.rows.map(mapUserRow);
}

export async function updateUserVaultKeys(
  userId: string,
  publicKey: string,
  encryptedPrivateKey: string,
  keySalt: string,
  signingPublicKey?: string
): Promise<void> {
  await getPool().query(
    `UPDATE users SET public_key = $2, encrypted_private_key = $3, key_salt = $4, signing_public_key = COALESCE($5, signing_public_key) WHERE id = $1`,
    [userId, publicKey, encryptedPrivateKey, keySalt, signingPublicKey ?? null]
  );
}

export async function updateUserPublicKey(userId: string, publicKey: string): Promise<void> {
  await getPool().query(`UPDATE users SET public_key = $2 WHERE id = $1`, [userId, publicKey]);
}

export async function rotateUserKeys(
  userId: string,
  publicKey: string,
  encryptedPrivateKey: string,
  keySalt: string,
  signature: string,
  oldPublicKey: string,
  signingPublicKey: string
): Promise<void> {
  await getPool().query(
    `UPDATE users SET public_key = $2, encrypted_private_key = $3, key_salt = $4,
        key_version = key_version + 1, key_rotation_signature = $5,
        old_public_key = $6, signing_public_key = $7, old_signing_public_key = signing_public_key
     WHERE id = $1`,
    [userId, publicKey, encryptedPrivateKey, keySalt, signature, oldPublicKey, signingPublicKey]
  );
}

export async function updateUserRole(userId: string, role: 'ADMIN' | 'SUPERVISOR' | 'MEMBER'): Promise<void> {
  await getPool().query(`UPDATE users SET role = $2 WHERE id = $1`, [userId, role]);
}

export async function updateUserAvatar(userId: string, avatarUrl: string | null): Promise<void> {
  await getPool().query(`UPDATE users SET avatar_url = $2 WHERE id = $1`, [userId, avatarUrl]);
}

export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  await getPool().query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
}

export async function updateUserStatus(userId: string, status: string): Promise<void> {
  await getPool().query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status]);
}

export async function revokeUserKeys(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET public_key = '', encrypted_private_key = NULL, key_salt = NULL,
     signing_public_key = NULL, key_version = key_version + 1 WHERE id = $1`,
    [userId]
  );
}

export async function updateUserProfile(userId: string, data: { fullName?: string; email?: string; avatarUrl?: string; status?: string; statusMessage?: string; username?: string; phone?: string }): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [userId];
  let idx = 2;
  if (data.fullName !== undefined) { sets.push(`full_name = $${idx++}`); vals.push(data.fullName); }
  if (data.email !== undefined) { sets.push(`email = $${idx++}`); vals.push(data.email); }
  if (data.avatarUrl !== undefined) { sets.push(`avatar_url = $${idx++}`); vals.push(data.avatarUrl); }
  if (data.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(data.status); }
  if (data.statusMessage !== undefined) { sets.push(`status_message = $${idx++}`); vals.push(data.statusMessage); }
  if (data.username !== undefined) { sets.push(`username = $${idx++}`); vals.push(data.username); }
  if (data.phone !== undefined) { sets.push(`phone = $${idx++}`); vals.push(data.phone); }
  if (sets.length === 0) return;
  await getPool().query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
}

export async function deleteUser(userId: string): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM channel_members WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM channel_keys WHERE user_id = $1`, [userId]);
  // Soft-delete messages: preserve history for other participants
  await db.query(`UPDATE messages SET is_deleted = TRUE WHERE sender_id = $1 OR recipient_id = $1`, [userId]);
  // Soft-delete: keep the tombstone row so login/register cannot resurrect the account.
  await db.query(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, [userId]);
}

// ── Channel Members ─────────────────────────────────────────────────────────

export async function addChannelMember(channelId: string, userId: string, assignedBy: string | undefined): Promise<void> {
  await getPool().query(
    `INSERT INTO channel_members (channel_id, user_id, assigned_by, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel_id, user_id) DO NOTHING`,
    [channelId, userId, assignedBy ?? null, Date.now()]
  );
}

export async function getChannelMembers(channelId: string): Promise<string[]> {
  const res = await getPool().query(`SELECT user_id FROM channel_members WHERE channel_id = $1`, [channelId]);
  return res.rows.map((r) => r.user_id);
}

async function getChannelMembersMap(channelIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (channelIds.length === 0) return map;
  const res = await getPool().query(
    `SELECT channel_id, user_id FROM channel_members WHERE channel_id = ANY($1)`,
    [channelIds]
  );
  for (const row of res.rows) {
    if (!map.has(row.channel_id)) map.set(row.channel_id, []);
    map.get(row.channel_id)!.push(row.user_id);
  }
  return map;
}

export async function getChannelsForUser(userId: string): Promise<DbChannel[]> {
  const channelIds = await getPool().query(
    'SELECT channel_id FROM channel_members WHERE user_id = $1',
    [userId]
  );
  if (channelIds.rows.length === 0) return [];
  const channelIdList = channelIds.rows.map((r) => r.channel_id);
  const res = await getPool().query(
    'SELECT * FROM channels WHERE id = ANY($1)',
    [channelIdList]
  );
  const channels = res.rows.map(mapChannelRow);
  const memberMap = await getChannelMembersMap(channelIdList);
  for (const channel of channels) {
    channel.memberIds = memberMap.get(channel.id) || [];
  }
  return channels;
}

export async function removeChannelMember(channelId: string, userId: string): Promise<void> {
  await getPool().query(`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, [channelId, userId]);
}

// ── Channels ────────────────────────────────────────────────────────────────

function mapChannelRow(row: any): DbChannel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    isAnnouncement: row.is_announcement || false,
    allowedRoles: row.allowed_roles || ['ADMIN', 'SUPERVISOR', 'MEMBER'],
    slowModeSeconds: row.slow_mode_seconds || 0,
  };
}

export async function insertChannel(channel: DbChannel): Promise<void> {
  await getPool().query(
    `INSERT INTO channels (id, name, description, type, created_by, created_at, is_announcement, allowed_roles)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [channel.id, channel.name, channel.description, channel.type, channel.createdBy, channel.createdAt, channel.isAnnouncement || false, channel.allowedRoles || ['ADMIN', 'SUPERVISOR', 'MEMBER']]
  );
}

export async function getAllChannels(userId?: string): Promise<DbChannel[]> {
  const res = await getPool().query('SELECT * FROM channels ORDER BY name ASC');
  const channels = res.rows.map(mapChannelRow);
  
  // Populate memberIds for each channel (single batch query)
  const memberMap = await getChannelMembersMap(channels.map(c => c.id));
  for (const channel of channels) {
    channel.memberIds = memberMap.get(channel.id) || [];
  }
  
  if (!userId) return channels;
  // Users see: all official channels + private/team channels they're members of
  return channels.filter(c => 
    c.type === 'official' || c.isAnnouncement || (c.memberIds || []).includes(userId)
  );
}

export async function getChannelById(channelId: string): Promise<DbChannel | undefined> {
  const res = await getPool().query('SELECT * FROM channels WHERE id = $1', [channelId]);
  if (!res.rows[0]) return undefined;
  const channel = mapChannelRow(res.rows[0]);
  channel.memberIds = await getChannelMembers(channel.id);
  return channel;
}

export async function updateChannel(channelId: string, data: Partial<Pick<DbChannel, 'name' | 'description' | 'isAnnouncement' | 'allowedRoles' | 'slowModeSeconds'>> & { memberIds?: string[] }): Promise<{ removedMembers: string[] }> {
  const sets: string[] = [];
  const vals: any[] = [channelId];
  let idx = 2;
  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(data.description); }
  if (data.isAnnouncement !== undefined) { sets.push(`is_announcement = $${idx++}`); vals.push(data.isAnnouncement); }
  if (data.allowedRoles !== undefined) { sets.push(`allowed_roles = $${idx++}`); vals.push(data.allowedRoles); }
  if (data.slowModeSeconds !== undefined) { sets.push(`slow_mode_seconds = $${idx++}`); vals.push(data.slowModeSeconds); }
  if (sets.length === 0 && !data.memberIds) return { removedMembers: [] };
  if (sets.length > 0) {
    await getPool().query(`UPDATE channels SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  
  const removedMembers: string[] = [];

  // Handle memberIds separately
  if (data.memberIds !== undefined) {
    // Get current members before removing
    const currentMembers = await getChannelMembers(channelId);
    const newMemberSet = new Set(data.memberIds);
    removedMembers.push(...currentMembers.filter(m => !newMemberSet.has(m)));

    // Remove all existing members
    await getPool().query(`DELETE FROM channel_members WHERE channel_id = $1`, [channelId]);
    // Add new members
    for (const memberId of data.memberIds) {
      await getPool().query(
        `INSERT INTO channel_members (channel_id, user_id, assigned_by, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channelId, memberId, 'system', Date.now()]
      );
    }

    // Security: Delete channel keys for removed members so they can no longer decrypt
    for (const removedId of removedMembers) {
      await deleteChannelKeysForUser(channelId, removedId);
    }
  }

  return { removedMembers };
}

export async function deleteChannel(channelId: string): Promise<void> {
  const db = getPool();
  // Get attachment file paths before deleting records
  const attachments = await db.query(
    `SELECT file_path FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)`,
    [channelId]
  );
  await db.query(`DELETE FROM channel_keys WHERE channel_id = $1`, [channelId]);
  await db.query(`DELETE FROM channel_members WHERE channel_id = $1`, [channelId]);
  await db.query(`DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)`, [channelId]);
  await db.query(`DELETE FROM messages WHERE channel_id = $1`, [channelId]);
  await db.query(`DELETE FROM channels WHERE id = $1`, [channelId]);
  // Delete physical attachment files
  const uploadsDir = path.resolve(path.join(__dirname, '..', '..', 'uploads'));
  for (const row of attachments.rows) {
    const filePath = path.resolve(path.join(uploadsDir, row.file_path));
    try { await fs.promises.unlink(filePath); } catch { /* ignore */ }
  }
}

// ── Channel Keys ────────────────────────────────────────────────────────────

export async function upsertChannelKeys(channelId: string, keys: DbChannelKey[]): Promise<void> {
  const db = getPool();
  for (const key of keys) {
    await db.query(
      `INSERT INTO channel_keys (channel_id, user_id, encrypted_channel_key, iv)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET encrypted_channel_key = EXCLUDED.encrypted_channel_key, iv = EXCLUDED.iv`,
      [channelId, key.userId, key.encryptedChannelKey, key.iv]
    );
  }
}

export async function deleteChannelKeysForUser(channelId: string, userId: string): Promise<void> {
  await getPool().query(`DELETE FROM channel_keys WHERE channel_id = $1 AND user_id = $2`, [channelId, userId]);
}

export async function getMembersWithoutKeyEnvelope(channelId: string): Promise<string[]> {
  const res = await getPool().query(
    `SELECT cm.user_id FROM channel_members cm
     LEFT JOIN channel_keys ck ON ck.channel_id = cm.channel_id AND ck.user_id = cm.user_id
     WHERE cm.channel_id = $1 AND ck.user_id IS NULL`,
    [channelId]
  );
  return res.rows.map(r => r.user_id);
}

export async function transferChannelOwnership(channelId: string, newOwnerId: string): Promise<void> {
  await getPool().query('UPDATE channels SET created_by = $1 WHERE id = $2', [newOwnerId, channelId]);
}

export async function deleteChannelKeysForChannel(channelId: string): Promise<void> {
  await getPool().query(`DELETE FROM channel_keys WHERE channel_id = $1`, [channelId]);
}

export async function getChannelKeysForChannel(channelId: string): Promise<DbChannelKey[]> {
  const res = await getPool().query(
    `SELECT channel_id, user_id, encrypted_channel_key, iv FROM channel_keys WHERE channel_id = $1`,
    [channelId]
  );
  return res.rows.map(r => ({
    channelId: r.channel_id,
    userId: r.user_id,
    encryptedChannelKey: r.encrypted_channel_key,
    iv: r.iv,
  }));
}

export async function getChannelKey(channelId: string, userId: string): Promise<DbChannelKey | undefined> {
  const res = await getPool().query(
    `SELECT channel_id, user_id, encrypted_channel_key, iv FROM channel_keys WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId]
  );
  const row = res.rows[0];
  return row
    ? { channelId: row.channel_id, userId: row.user_id, encryptedChannelKey: row.encrypted_channel_key, iv: row.iv }
    : undefined;
}

// ── Messages ────────────────────────────────────────────────────────────────

const MSG_COLS = 'id, temp_id, sender_id, recipient_id, channel_id, ciphertext, iv, status, is_edited, is_deleted, reply_to, created_at';

function mapMessageRow(row: any): DbMessage {
  return {
    id: row.id,
    tempId: row.temp_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    channelId: row.channel_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    status: row.status,
    isEdited: row.is_edited,
    isDeleted: row.is_deleted,
    replyTo: row.reply_to,
    createdAt: row.created_at,
  };
}

export async function insertMessage(msg: DbMessage): Promise<void> {
  await getPool().query(
    `INSERT INTO messages (id, temp_id, sender_id, recipient_id, channel_id, ciphertext, iv, status, is_edited, is_deleted, reply_to, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO NOTHING`,
    [msg.id, msg.tempId ?? null, msg.senderId, msg.recipientId ?? null, msg.channelId ?? null, msg.ciphertext, msg.iv, msg.status, msg.isEdited ?? false, msg.isDeleted ?? false, msg.replyTo ?? null, msg.createdAt]
  );
}

/** Messages in a direct thread between two users (order-independent) */
export async function getDirectMessages(userA: string, userB: string, limit = 500, offset = 0): Promise<DbMessage[]> {
  const res = await getPool().query(
    `SELECT ${MSG_COLS} FROM messages
     WHERE recipient_id IS NOT NULL AND (
       (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     )
     ORDER BY created_at ASC
     LIMIT $3 OFFSET $4`,
    [userA, userB, limit, offset]
  );
  return res.rows.map(mapMessageRow);
}

export async function getChannelMessages(channelId: string): Promise<DbMessage[]> {
  const res = await getPool().query(
    `SELECT ${MSG_COLS} FROM messages WHERE channel_id = $1 ORDER BY created_at ASC`,
    [channelId]
  );
  return res.rows.map(mapMessageRow);
}

export async function getMessageById(id: string): Promise<DbMessage | undefined> {
  const res = await getPool().query(`SELECT ${MSG_COLS} FROM messages WHERE id = $1`, [id]);
  return res.rows[0] ? mapMessageRow(res.rows[0]) : undefined;
}

/** Full history for a user: their DM threads plus every channel message */
export async function getMessagesForUser(userId: string, limit = 500, offset = 0): Promise<DbMessage[]> {
  const res = await getPool().query(
    `SELECT ${MSG_COLS} FROM messages
     WHERE (sender_id = $1 OR recipient_id = $1)
        OR (channel_id IS NOT NULL AND channel_id IN (
              SELECT channel_id FROM channel_members WHERE user_id = $1
            ))
     ORDER BY created_at ASC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return res.rows.map(mapMessageRow);
}

/** Mark incoming DM messages as delivered when the recipient fetches history */
export async function markIncomingDelivered(recipientId: string): Promise<void> {
  await getPool().query(
    `UPDATE messages SET status = 'delivered'
     WHERE recipient_id = $1 AND status = 'sent'`,
    [recipientId]
  );
}

/** Get undelivered DM messages for a user (status = 'sent' and recipient_id = userId) */
export async function getUndeliveredMessages(recipientId: string): Promise<DbMessage[]> {
  const res = await getPool().query(
    `SELECT ${MSG_COLS} FROM messages 
     WHERE recipient_id = $1 AND status = 'sent'
     ORDER BY created_at ASC`,
    [recipientId]
  );
  return res.rows.map(mapMessageRow);
}

export async function updateMessageEdit(id: string, ciphertext: string, iv: string): Promise<void> {
  await getPool().query(
    `UPDATE messages SET ciphertext = $2, iv = $3, is_edited = TRUE WHERE id = $1`,
    [id, ciphertext, iv]
  );
}

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export async function updateMessageStatus(id: string, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  // Prevent status downgrade (e.g. 'read' → 'delivered' from stale receipt)
  const res = await getPool().query(`SELECT status FROM messages WHERE id = $1`, [id]);
  const current = res.rows[0]?.status;
  if (current && (STATUS_RANK[current] ?? 0) > (STATUS_RANK[status] ?? 0)) return;
  await getPool().query(
    `UPDATE messages SET status = $2 WHERE id = $1`,
    [id, status]
  );
}

export async function markMessageDeleted(id: string): Promise<void> {
  await getPool().query(`UPDATE messages SET is_deleted = TRUE WHERE id = $1`, [id]);
}

export async function deleteUndecryptableMessages(): Promise<number> {
  const res = await getPool().query(
    `DELETE FROM messages WHERE ciphertext IS NOT NULL AND (status = 'sent' OR status = 'delivered') AND id LIKE 'temp_%' RETURNING id`
  );
  return res.rowCount ?? 0;
}

// ── Attachments ─────────────────────────────────────────────────────────────

export async function insertAttachment(att: DbAttachment): Promise<void> {
  await getPool().query(
    `INSERT INTO attachments (id, message_id, file_path, encrypted_metadata, iv, metadata_iv, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [att.id, att.messageId ?? null, att.filePath, att.encryptedMetadata, att.iv, att.metadataIv, att.createdAt]
  );
}

export async function getAttachmentById(id: string): Promise<DbAttachment | undefined> {
  const res = await getPool().query(
    `SELECT id, message_id, file_path, encrypted_metadata, iv, metadata_iv, created_at FROM attachments WHERE id = $1`,
    [id]
  );
  const row = res.rows[0];
  return row
    ? {
        id: row.id,
        messageId: row.message_id,
        filePath: row.file_path,
        encryptedMetadata: row.encrypted_metadata,
        iv: row.iv,
        metadataIv: row.metadata_iv,
        createdAt: Number(row.created_at),
      }
    : undefined;
}

export async function getAttachmentByMessageId(messageId: string): Promise<DbAttachment | undefined> {
  const res = await getPool().query(
    `SELECT id, message_id, file_path, encrypted_metadata, iv, metadata_iv, created_at FROM attachments WHERE message_id = $1`,
    [messageId]
  );
  const row = res.rows[0];
  return row
    ? {
        id: row.id,
        messageId: row.message_id,
        filePath: row.file_path,
        encryptedMetadata: row.encrypted_metadata,
        iv: row.iv,
        metadataIv: row.metadata_iv,
        createdAt: Number(row.created_at),
      }
    : undefined;
}

export async function getAttachmentsByMessageIds(messageIds: string[]): Promise<Map<string, DbAttachment>> {
  if (messageIds.length === 0) return new Map();
  const res = await getPool().query(
    `SELECT id, message_id, file_path, encrypted_metadata, iv, metadata_iv, created_at FROM attachments WHERE message_id = ANY($1)`,
    [messageIds]
  );
  const map = new Map<string, DbAttachment>();
  for (const row of res.rows) {
    map.set(row.message_id, {
      id: row.id,
      messageId: row.message_id,
      filePath: row.file_path,
      encryptedMetadata: row.encrypted_metadata,
      iv: row.iv,
      metadataIv: row.metadata_iv,
      createdAt: Number(row.created_at),
    });
  }
  return map;
}

export async function linkAttachmentToMessage(attachmentId: string, messageId: string): Promise<void> {
  const msg = await getPool().query(`SELECT id FROM messages WHERE id = $1`, [messageId]);
  if (msg.rows.length === 0) throw new Error('Message not found');
  await getPool().query(`UPDATE attachments SET message_id = $2 WHERE id = $1`, [attachmentId, messageId]);
}

// ── Health / Shutdown ───────────────────────────────────────────────────────

export async function addReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  const db = getPool();
  await db.query(
    'INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [messageId, userId, emoji, Date.now()]
  );
}

export async function removeReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  const db = getPool();
  await db.query(
    'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, userId, emoji]
  );
}

export async function getReactionsForMessage(messageId: string): Promise<{ userId: string; emoji: string }[]> {
  const db = getPool();
  const res = await db.query(
    'SELECT user_id, emoji FROM message_reactions WHERE message_id = $1',
    [messageId]
  );
  return res.rows.map((r: any) => ({ userId: r.user_id, emoji: r.emoji }));
}

export async function getReactionsForMessages(messageIds: string[]): Promise<Record<string, { userId: string; emoji: string }[]>> {
  if (messageIds.length === 0) return {};
  const db = getPool();
  const res = await db.query(
    'SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id = ANY($1)',
    [messageIds]
  );
  const map: Record<string, { userId: string; emoji: string }[]> = {};
  for (const r of res.rows) {
    if (!map[r.message_id]) map[r.message_id] = [];
    map[r.message_id].push({ userId: r.user_id, emoji: r.emoji });
  }
  return map;
}

export async function pinMessage(channelId: string, messageId: string, pinnedBy: string): Promise<void> {
  const db = getPool();
  await db.query(
    'INSERT INTO pinned_messages (channel_id, message_id, pinned_by, pinned_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [channelId, messageId, pinnedBy, Date.now()]
  );
}

export async function unpinMessage(channelId: string, messageId: string): Promise<void> {
  const db = getPool();
  await db.query('DELETE FROM pinned_messages WHERE channel_id = $1 AND message_id = $2', [channelId, messageId]);
}

export async function getPinnedMessages(channelId: string): Promise<{ messageId: string; pinnedBy: string; pinnedAt: number }[]> {
  const db = getPool();
  const res = await db.query('SELECT message_id, pinned_by, pinned_at FROM pinned_messages WHERE channel_id = $1 ORDER BY pinned_at DESC', [channelId]);
  return res.rows.map((r: any) => ({ messageId: r.message_id, pinnedBy: r.pinned_by, pinnedAt: r.pinned_at }));
}

export async function starMessage(userId: string, messageId: string): Promise<void> {
  const db = getPool();
  await db.query(
    'INSERT INTO starred_messages (user_id, message_id, starred_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [userId, messageId, Date.now()]
  );
}

export async function unstarMessage(userId: string, messageId: string): Promise<void> {
  const db = getPool();
  await db.query('DELETE FROM starred_messages WHERE user_id = $1 AND message_id = $2', [userId, messageId]);
}

export async function getStarredMessages(userId: string): Promise<{ messageId: string; starredAt: number }[]> {
  const db = getPool();
  const res = await db.query('SELECT message_id, starred_at FROM starred_messages WHERE user_id = $1 ORDER BY starred_at DESC', [userId]);
  return res.rows.map((r: any) => ({ messageId: r.message_id, starredAt: r.starred_at }));
}

export async function getStarredStatus(userId: string, messageIds: string[]): Promise<Record<string, boolean>> {
  if (messageIds.length === 0) return {};
  const db = getPool();
  const res = await db.query(
    'SELECT message_id FROM starred_messages WHERE user_id = $1 AND message_id = ANY($2)',
    [userId, messageIds]
  );
  const map: Record<string, boolean> = {};
  for (const r of res.rows) map[r.message_id] = true;
  return map;
}

// ── Blocked Users ────────────────────────────────────────────────────────────

export async function blockUserOnServer(blockerId: string, blockedId: string): Promise<void> {
  const db = getPool();
  await db.query(
    'INSERT INTO blocked_users (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [blockerId, blockedId, Date.now()]
  );
}

export async function unblockUserOnServer(blockerId: string, blockedId: string): Promise<void> {
  const db = getPool();
  await db.query('DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
}

export async function isUserBlockedBy(blockerId: string, blockedId: string): Promise<boolean> {
  const db = getPool();
  const res = await db.query('SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
  return (res.rowCount ?? 0) > 0;
}

export async function getBlockedUsersOf(userId: string): Promise<string[]> {
  const db = getPool();
  const res = await db.query('SELECT blocked_id FROM blocked_users WHERE blocker_id = $1', [userId]);
  return res.rows.map(r => r.blocked_id);
}

export async function getBlockedByUsers(userId: string): Promise<string[]> {
  const db = getPool();
  const res = await db.query('SELECT blocker_id FROM blocked_users WHERE blocked_id = $1', [userId]);
  return res.rows.map(r => r.blocker_id);
}

// ── Audit Log ───────────────────────────────────────────────────────────────

export async function logAudit(actorId: string, action: string, targetType?: string, targetId?: string, details?: string): Promise<void> {
  await getPool().query(
    'INSERT INTO audit_log (actor_id, action, target_type, target_id, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [actorId, action, targetType || null, targetId || null, details || null, Date.now()]
  );
}

export async function getAuditLog(limit = 100, offset = 0): Promise<{ actorId: string; action: string; targetType?: string; targetId?: string; details?: string; createdAt: number }[]> {
  const res = await getPool().query(
    'SELECT actor_id, action, target_type, target_id, details, created_at FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return res.rows.map(r => ({
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: r.details,
    createdAt: Number(r.created_at),
  }));
}

// ── Token Blocklist ─────────────────────────────────────────────────────────

export async function blockToken(tokenHash: string, userId: string, expiresAt: number): Promise<void> {
  await getPool().query(
    'INSERT INTO token_blocklist (token_hash, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING',
    [tokenHash, userId, expiresAt]
  );
}

export async function isTokenBlocked(tokenHash: string): Promise<boolean> {
  const res = await getPool().query('SELECT 1 FROM token_blocklist WHERE token_hash = $1 AND expires_at > $2', [tokenHash, Date.now()]);
  return (res.rowCount ?? 0) > 0;
}

export async function cleanupExpiredTokens(): Promise<void> {
  await getPool().query('DELETE FROM token_blocklist WHERE expires_at < $1', [Date.now()]);
}

export async function getDatabaseStats(): Promise<{ users: number; channels: number; messages: number; attachments: number }> {
  const db = getPool();
  const [users, channels, messages, attachments] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS c FROM users'),
    db.query('SELECT COUNT(*)::int AS c FROM channels'),
    db.query('SELECT COUNT(*)::int AS c FROM messages'),
    db.query('SELECT COUNT(*)::int AS c FROM attachments'),
  ]);
  return {
    users: users.rows[0].c,
    channels: channels.rows[0].c,
    messages: messages.rows[0].c,
    attachments: attachments.rows[0].c,
  };
}

export async function getDatabaseSize(): Promise<{ bytes: number; pretty: string }> {
  const db = getPool();
  const res = await db.query("SELECT pg_database_size(current_database())::bigint AS bytes");
  const bytes = Number(res.rows[0].bytes);
  return { bytes, pretty: formatBytes(bytes) };
}

export async function getUploadsSize(): Promise<{ bytes: number; pretty: string; fileCount: number }> {
  const uploadsDir = getUploadsDir();
  let totalBytes = 0;
  let fileCount = 0;
  try {
    const files = fs.readdirSync(uploadsDir);
    for (const f of files) {
      const stat = fs.statSync(path.join(uploadsDir, f));
      if (stat.isFile()) {
        totalBytes += stat.size;
        fileCount++;
      }
    }
  } catch { /* uploads dir may not exist yet */ }
  return { bytes: totalBytes, pretty: formatBytes(totalBytes), fileCount };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export async function shutdownDatabase(): Promise<void> {
  try { await pool?.end(); } catch { /* ignore */ }
  if (embedded) {
    try { await embedded.stop(); } catch { /* ignore */ }
  }
}

export async function cleanupOrphanedAttachments(): Promise<{ count: number; filePaths: string[] }> {
  const p = getPool();
  const result = await p.query(
    `DELETE FROM attachments WHERE message_id IS NULL AND created_at < $1 RETURNING id, file_path`,
    [Date.now() - 3600000]
  );
  return { count: result.rows.length, filePaths: result.rows.map((r: any) => r.file_path) };
}
