import type { CoreEvent, PlayerId, PlayerInput } from '@tetrisvs/core';

export interface ClientToServerEvents {
  'matchmaking:join': (pool: string, reply: (result: { searching: boolean }) => void) => void;
  'matchmaking:cancel': (reply: (result: { cancelled: boolean }) => void) => void;
  'room:create': (reply: (result: { roomCode: string; playerId: PlayerId }) => void) => void;
  'room:join': (roomCode: string, reply: (result: { ok: boolean; playerId?: PlayerId; reason?: string }) => void) => void;
  'match:input': (input: PlayerInput) => void;
}

export interface ServerToClientEvents {
  'matchmaking:searching': () => void;
  'matchmaking:matched': (result: { roomCode: string; playerId: PlayerId }) => void;
  'room:ready': (roomCode: string) => void;
  'match:update': (update: { frame: number; hash: number; events: CoreEvent[]; snapshot: string }) => void;
  'match:ended': (winner: PlayerId | null) => void;
  'peer:disconnected': () => void;
}

export interface SocketData {
  roomCode?: string;
  playerId?: PlayerId;
}
