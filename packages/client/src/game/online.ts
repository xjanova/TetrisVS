import { io, type Socket } from 'socket.io-client';
import type { CoreEvent, PlayerId, PlayerInput } from '@tetrisvs/core';

interface ServerEvents {
  'matchmaking:searching': () => void;
  'matchmaking:matched': (result: { roomCode: string; playerId: PlayerId }) => void;
  'room:ready': (roomCode: string) => void;
  'match:update': (update: { frame: number; hash: number; events: CoreEvent[]; snapshot: string }) => void;
  'match:ended': (winner: PlayerId | null) => void;
  'peer:disconnected': () => void;
}

interface ClientEvents {
  'matchmaking:join': (pool: string, reply: (result: { searching: boolean }) => void) => void;
  'matchmaking:cancel': (reply: (result: { cancelled: boolean }) => void) => void;
  'room:create': (reply: (result: { roomCode: string; playerId: PlayerId }) => void) => void;
  'room:join': (roomCode: string, reply: (result: { ok: boolean; playerId?: PlayerId; reason?: string }) => void) => void;
  'match:input': (input: PlayerInput) => void;
}

export type OnlineSocket = Socket<ServerEvents, ClientEvents>;

export function connectOnline(): OnlineSocket {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  const url = configured ?? `${window.location.protocol}//${window.location.hostname}:3001`;
  return io(url, { transports: ['websocket'], timeout: 5000 });
}

export function snapshotBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
