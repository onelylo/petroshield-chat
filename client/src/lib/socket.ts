import { io, Socket } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export const socket: Socket = io(SERVER_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  // L1: Force WebSocket transport (no HTTP long-polling fallback)
  transports: ['websocket'],
});

/** Call this before each connect to ensure the latest JWT is sent */
export function connectSocket() {
  const token = localStorage.getItem('petroshield_jwt') || sessionStorage.getItem('petroshield_jwt');
  socket.auth = { token };
  if (!socket.connected) {
    socket.connect();
  }
}
