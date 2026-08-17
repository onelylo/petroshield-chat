# PetroShield — End-to-End Encrypted Messenger

> **Version 1.0.0** — Secure, enterprise-grade real-time messaging with E2EE  
> **Repository**: https://github.com/onelylo/petroshield-chat  
> **Status**: Stable release — all core E2EE flows verified

---

## Overview

PetroShield is a real-time messaging platform with **true end-to-end encryption**. The server never sees plaintext — only ciphertext and IVs are stored. Private keys are encrypted with your password via PBKDF2 before any server interaction.

### Core Features

- **E2EE**: ECDH-P256 key exchange + AES-256-GCM message encryption
- **Real-time messaging**: Delivery/read receipts (✓ sent, ✓✓ delivered, ✓✓ blue = read)
- **Encrypted attachments**: Up to 25 MB with thumbnail generation
- **Voice messages**: Recording and playback
- **Message editing/deletion**: For self or everyone
- **Channel pins & starring**: Pin messages in channels, star DMs
- **Typing indicators**: DMs and channels
- **Reply threading**: Quoted messages with jump-to-message
- **Shared media gallery**: WhatsApp-style (images, audio, video, docs with date grouping)
- **Contextual message menu**: Reply, Edit, Copy, Delete
- **Image lightbox**: Zoom, pan, slide-down-to-close
- **Multi-device presence**: Online (green), Away >5min (amber), Offline (gray)
- **12 themes**: 6 dark, 6 light with smooth transitions
- **TOFU key verification**: Trust On First Use with rotation signatures
- **Admin dashboard**: User management, roles (ADMIN/SUPERVISOR/MEMBER)
- **Offline queue**: Auto-flush on reconnect
- **Keyboard shortcuts**: Ctrl+K search, and more

---

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL (embedded via `pg` in server)

### Install & Run

```bash
# Server
cd server
npm install
npm run dev

# Client (new terminal)
cd client
npm install
npm run dev
```

### Environment Variables

**Server** (`server/.env`):
```env
PORT=3001
DB_USER=postgres
DB_PASS=your_password
DB_NAME=petroshield
JWT_SECRET=your_secure_random_string
ADMIN_PASSWORD=secure_admin_password
API_BASE=http://localhost:3001
```

**Client** (`client/.env`):
```env
VITE_API_BASE=http://localhost:3001
```

---

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Client | React 18, TypeScript, Vite, Tailwind CSS, Dexie.js (IndexedDB) |
| Server | Node.js, Express, Socket.IO, PostgreSQL |
| Crypto | Web Crypto API, ECDH-P256, AES-256-GCM, ECDSA-P256 |
| Auth | JWT (HS256), bcrypt (12 rounds) |

### Key Files

| File | Purpose |
|------|---------|
| `client/src/App.tsx` | Main app state, auth, E2EE, socket handlers, message flow |
| `client/src/components/ChatArea.tsx` | Chat UI, message list, useLiveQuery, scroll behavior |
| `client/src/components/Sidebar.tsx` | DM/channel list, unread badges, search |
| `client/src/lib/crypto.ts` | ECDH key derivation, AES-256-GCM encrypt/decrypt |
| `client/src/lib/db.ts` | Dexie IndexedDB schema, message CRUD, status updates |
| `client/src/lib/socket.ts` | Socket.IO connection with JWT auth |
| `server/src/index.ts` | All API routes, socket handlers, message relay |
| `server/src/db/index.ts` | PostgreSQL queries, schema migrations |

### Message Flow

```
Client A                          Server                           Client B
   │                                 │                                │
   │── encrypt(ECDH) ── socket.emit ─>│                                │
   │                                 │── relay ciphertext ───────────>│
   │                                 │                                │── decrypt(ECDH)
   │                                 │<── socket.emit('receive') ─────│
   │<── message:ack (serverId) ──────│                                │
   │                                 │<── message:delivered ─────────│
   │<── message:delivered_ack ───────│                                │
   │                                 │<── message:read ──────────────│
   │<── message:read_ack ────────────│                                │
```

---

## Security

See [SECURITY.md](./SECURITY.md) for detailed cryptographic documentation, threat model, and known limitations.

**TL;DR**: Strong crypto primitives (ECDH-P256, AES-256-GCM, PBKDF2 100K, ECDSA-P256), timing-safe comparisons, parameterized SQL, TOFU verification, socket rate limits, SSRF protection, unlinked attachment deny.

---

## Development

### Commands

```bash
# Client
cd client
npm run dev      # Start dev server
npm run build    # Production build
npm run lint     # ESLint
npm run typecheck # TypeScript check

# Server
cd server
npm run dev      # Start with tsx watch
npm run build    # Compile TypeScript
npm run lint     # ESLint
```

### Testing
No test suite yet — see [Known Limitations](#known-limitations).

---

## Known Limitations

| Item | Priority | Notes |
|------|----------|-------|
| PBKDF2 100K → 600K + vault migration | HIGH | Requires vault re-wrap on login |
| JWT in localStorage → httpOnly cookies | HIGH | Needs cookie auth for socket |
| Pagination for message APIs | HIGH | O(n) memory on large histories |
| Split App.tsx into composable hooks | MEDIUM | 2,800+ lines, untestable |
| Virtualize message list (react-window) | MEDIUM | Lag on 500+ messages |
| Add tests (Vitest/Jest + CI) | MEDIUM | No regression safety |
| Clean up ~40 console.log | LOW | Info leakage in browser console |
| Structured logging + error tracking | LOW | No observability in production |

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with clear commits
4. Run `npm run lint && npm run typecheck` in both client/server
5. Submit a PR

---

## Acknowledgments

Built with security-first principles. Inspired by Signal's double-ratchet (simplified) and WhatsApp's UX patterns.