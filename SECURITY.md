# PetroShield — Security & E2EE Documentation

> **Last updated**: 2026-08-16  
> **Status**: E2EE properly implemented — channel key re-distribution working, socket rate limits active, SSRF fixed, unlinked attachment deny active

---

## Executive Summary

PetroShield implements **end-to-end encryption** using **ECDH P-256** key exchange and **AES-256-GCM** message encryption. The server **never sees plaintext** — all messages, attachments, and channel keys are encrypted client-side before transmission. Private keys are encrypted with **PBKDF2 + AES-256-GCM** (100K iterations) before server storage.

**Security Rating: Good** — strong crypto primitives, timing-safe comparisons, parameterized SQL, TOFU key verification, socket rate limiting, SSRF protection, unlinked attachment denial, last-admin guard. Remaining gap: PBKDF2 iterations at 100K (OWASP recommends 600K, requires vault migration).

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT SIDE                          │
│                                                             │
│  ┌──────────┐    ECDH P-256     ┌──────────────────┐       │
│  │ User A   │ ───────────────── │ User B Public Key │       │
│  │ Private  │                   │ (from server)     │       │
│  │ Key      │                   └──────────────────┘       │
│  └──────────┘                                               │
│       │                                                     │
│       ▼                                                     │
│  deriveSharedKey() → AES-256-GCM shared key                │
│       │                                                     │
│       ▼                                                     │
│  encryptMessage(text, sharedKey) → {ciphertext, iv}        │
│       │                                                     │
└───────┼─────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                        SERVER SIDE                          │
│                                                             │
│  Stores: ciphertext + iv (NO plaintext)                    │
│  Stores: encrypted channel keys per member                 │
│  Never has access to private keys or shared keys           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Cryptographic Primitives

### 2.1 Key Exchange: ECDH P-256
- **Algorithm**: Elliptic Curve Diffie-Hellman on NIST P-256 curve
- **Purpose**: Derive a shared AES key between two peers without transmitting the key
- **WebCrypto API**: `crypto.subtle.deriveKey()` with `{ name: 'ECDH', public: peerPublicKey }`
- **Key properties**: `extractable: false`, usage `['encrypt', 'decrypt']`
- **Implementation**: `deriveSharedKey()` in `client/src/lib/crypto.ts`

### 2.2 Message Encryption: AES-256-GCM
- **Algorithm**: AES-GCM (Galois/Counter Mode)
- **Key size**: 256 bits
- **IV**: Fresh random 12-byte (96-bit) IV for every message via `crypto.getRandomValues(new Uint8Array(12))`
- **Authentication**: GCM provides both confidentiality and integrity (16-byte auth tag appended to ciphertext)
- **Implementation**: `encryptMessage()` / `decryptMessage()` in `client/src/lib/crypto.ts`

### 2.3 Key Generation: ECDH P-256 + ECDSA P-256
- **ECDH P-256**: For key exchange (client-to-client)
- **ECDSA P-256**: For key rotation signatures (separate key pair, required by WebCrypto)
- **Key pair generation**: `generateKeyPair()` and `generateSigningKeyPair()`
- **Key export**: SPKI format for transport, JWK for IndexedDB storage

### 2.4 Vault Encryption: PBKDF2 + AES-256-GCM
- **Password key derivation**: PBKDF2-HMAC-SHA256, 100,000 iterations, 16-byte random salt
- **Key wrapping**: Derived password key wraps the ECDH + ECDSA private key JWKs
- **Implementation**: `encryptKeyVaultPair()` / `decryptKeyVaultPair()` in `client/src/lib/crypto.ts`

### 2.5 Key Rotation: ECDSA Signatures
- **Signing key**: ECDSA P-256 (separate from ECDH keys)
- **Statement format**: `petroshield-key-rotation-v1\n{newPublicKey}\n{newSigningPublicKey}\n{oldPublicKey}`
- **Verification**: `verifyKeyRotationSignature()` checks signature against old public key
- **TOFU**: First key encounter pins the fingerprint in IndexedDB
- **Creator-only rotation**: Only channel creator generates/distributes rotated key; others clear cache and wait

---

## 3. Security Properties

### 3.1 Confidentiality
- ✅ Messages encrypted with AES-256-GCM before leaving the client
- ✅ Attachments encrypted client-side before upload
- ✅ Channel keys wrapped per-member with ECDH shared keys
- ✅ Server stores only ciphertext + IV, never plaintext
- ✅ Private keys encrypted with PBKDF2 + AES-256-GCM before server storage

### 3.2 Integrity
- ✅ AES-GCM provides 16-byte authentication tag
- ✅ Tampered ciphertext will fail decryption with `OperationError`
- ✅ TOFU fingerprint comparison uses strict full-string equality (no prefix matching)

### 3.3 Authentication
- ✅ JWT (HS256) with timing-safe signature verification
- ✅ Bcrypt (12 rounds) for password hashing
- ✅ Legacy SHA-256 passwords use `crypto.timingSafeEqual` for timing-safe comparison
- ✅ Socket auth via JWT middleware — identity verified on every connection
- ✅ Server resolves roles from database, never trusts client-supplied role

### 3.4 Forward Secrecy
- ⚠️ **Partial** — No perfect forward secrecy (PFS). If a private key is compromised, all past messages encrypted with that key can be decrypted. Mitigated by key rotation (creates new ECDH key pairs) and TOFU verification.

### 3.5 Key Rotation
- ✅ ECDSA-signed rotation statements bind old and new keys
- ✅ Key version incremented on rotation
- ✅ TOFU verification checks old fingerprint matches
- ✅ `verifyKeyRotationSignature` is fail-closed (returns `false` on any error)
- ✅ Client-side `mitmWarnings` set on failed verification, blocking message send
- ✅ Only channel creator generates/distributes rotated key
- ✅ Stale closure fixes: handlers use refs (`currentUserKeysRef`, `channelsRef`, `allUsersRef`)

---

## 4. Security Controls

| Control | Implementation | Status |
|---------|---------------|--------|
| JWT signature | `crypto.timingSafeEqual` | ✅ Timing-safe |
| Legacy password hash | `crypto.timingSafeEqual` | ✅ Timing-safe |
| Bcrypt | 12 rounds | ✅ OWASP compliant |
| SQL injection | Parameterized queries (`$1, $2...`) | ✅ |
| Rate limiting (auth) | 10 req/min per IP | ✅ |
| Socket auth | JWT middleware on connection | ✅ |
| Role verification | Server-side DB lookup | ✅ |
| Input validation | Ciphertext type check, length limits | ✅ |
| CORS | Restricted origin | ✅ |
| Helmet | Security headers | ✅ |
| CSP | Content Security Policy | ✅ |
| Fail-closed TOFU | Returns `false` on any error | ✅ |
| Socket rate limits | 10 msg/s, 10 reactions/10s, 1 channel/30s, 2 typing/s | ✅ |
| Key rotation rate limit | 3 rotations/hour/user | ✅ |
| Attachment upload rate limit | 10 uploads/min/user | ✅ |
| SSRF protection | DNS resolved before IP check | ✅ |
| Unlinked attachment deny | `messageId=null` → 403 | ✅ |
| Last admin guard | At least 1 admin required | ✅ |
| Orphaned attachment cleanup | 30-min interval + DB function | ✅ |

---

## 5. Known Issues

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | **High** | PBKDF2 100K iterations (OWASP recommends 600K) | Needs vault migration |
| 2 | **Medium** | JWT in localStorage (not httpOnly cookies) | Needs cookie auth for socket |
| 3 | **Medium** | No pagination on `/api/messages` | O(n) memory on large histories |
| 4 | **Low** | JWT blocklist in-memory, resets on server restart | Acceptable (1h expiry) |
| 5 | **Low** | SlowMode tracker in-memory only | Resets on restart |
| 6 | **Low** | Rate limit maps grow unboundedly | Needs periodic cleanup |
| 7 | **Low** | Missing `reply_to` foreign key constraint | Client handles orphaned replies |
| 8 | **Low** | `getAllUsers` loads `password_hash` into memory | `publicUser()` strips before sending |
| 9 | **Low** | Fingerprint only 8 hex chars | Weak collision resistance |
| 10 | **Low** | ~40 `console.log` statements in production | Cleanup needed |

---

## 6. Fixed Security Issues (v1.0.0)

| Issue | Fix | Files |
|-------|-----|-------|
| Channel key not re-distributed on member add | `onChannelMemberAdded` handler distributes key | `client/src/App.tsx` |
| No socket rate limiting | Per-connection limits on message/reaction/typing/channel create | `server/src/index.ts` |
| No key rotation rate limiting | 3/hr/user limit | `server/src/index.ts` |
| SSRF via DNS rebinding | Resolve DNS before IP check | `server/src/index.ts` |
| Unlinked attachment access | Deny download when `messageId=null` | `server/src/index.ts` |
| Channel key distribution race | Await `channel:create:ack` + 3-attempt retry | `client/src/App.tsx`, `server/src/index.ts` |
| Key upload filters to `channel_keys` only | Open channels store all envelopes | `server/src/index.ts` |
| Creator offline = new members no key | Any online member can distribute | `client/src/App.tsx` |
| Official channel messages silent fail | Toast on key failure, ACK error handling | `client/src/App.tsx`, `server/src/index.ts` |
| `dangerouslySetInnerHTML` in ConfirmDialog | Replaced with plain text | `client/src/ConfirmDialog.tsx` |
| Last admin demotion | Guard prevents last admin removal | `server/src/index.ts` |
| Password change doesn't invalidate sessions | `user:password_changed` socket event forces logout | `server/src/index.ts`, `client/src/App.tsx` |
| Channel edit/delete broadcasts to ALL | `socket.to('channel:id').emit` | `server/src/index.ts` |
| Username spoofing in `user:join` | Server uses DB-resolved values | `server/src/index.ts` |
| `arrayBufferToBase64` O(n²) | 32KB chunking | `client/src/lib/crypto.ts` |

---

## 7. Recommendations

1. **[Critical] PBKDF2 migration**: Upgrade from 100K to 600K iterations with vault re-wrap on login
2. **[High] JWT → httpOnly cookies**: Migrate token storage, adapt socket auth
3. **[High] Pagination**: Implement cursor-based pagination on `/api/messages`
4. **[Medium] Hook extraction**: Split `App.tsx` into composable, testable hooks
5. **[Medium] Virtualization**: Add `react-window` for 1000+ message performance
6. **[Medium] Test suite**: Vitest + CI for regression safety
7. **[Low] Console cleanup**: Remove ~40 debug `console.log` statements
8. **[Low] Structured logging**: Add Pino/Winston for production observability

---

## 8. E2EE Verification Checklist

- [x] Client generates ECDH + ECDSA key pairs locally
- [x] Private keys encrypted with PBKDF2-derived key before storage
- [x] Public keys sent to server for distribution
- [x] Messages encrypted with AES-256-GCM using ECDH-derived shared key
- [x] Fresh 12-byte IV per message
- [x] Attachments encrypted client-side before upload
- [x] Channel symmetric keys wrapped per-member via ECDH
- [x] Server stores only ciphertext + IV (verified via DB inspection)
- [x] Key rotation uses ECDSA signatures verified against old public key
- [x] TOFU: fingerprint pinned on first encounter, rotation verified
- [x] `timingSafeEqual` used for legacy password comparison
- [x] Parameterized SQL queries everywhere
- [x] Socket auth middleware validates JWT on connection
- [x] Rate limits on all socket events and auth endpoints
- [x] SSRF protection on URL preview
- [x] Unlinked attachment access denied
- [x] Last admin demotion prevented
- [x] Orphaned attachment cleanup job running