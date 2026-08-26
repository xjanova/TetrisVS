import { io, type Socket } from 'socket.io-client';
import { decodeSnapshotFrame, deserialize, type CoreEvent, type MatchState, type PlayerId, type PlayerInput } from '@tetrisvs/core';

export type EndReason = 'topout' | 'forfeit';

export interface MatchUpdate {
  frame: number;
  hash: number | null;
  events: CoreEvent[];
  /** Full snapshot or a delta against the previous frame — see `SnapshotStream`. */
  snapshot: ArrayBuffer | Uint8Array;
  full: boolean;
}

interface ServerEvents {
  'matchmaking:searching': () => void;
  'matchmaking:matched': (result: { roomCode: string; playerId: PlayerId }) => void;
  'room:ready': (roomCode: string) => void;
  'match:update': (update: MatchUpdate) => void;
  'match:ended': (winner: PlayerId | null, reason: EndReason) => void;
  'peer:disconnected': () => void;
}

interface ClientEvents {
  'matchmaking:join': (pool: string, reply: (result: { searching: boolean }) => void) => void;
  'matchmaking:cancel': (reply: (result: { cancelled: boolean }) => void) => void;
  'room:create': (reply: (result: { roomCode: string; playerId: PlayerId }) => void) => void;
  'room:join': (roomCode: string, reply: (result: { ok: boolean; playerId?: PlayerId; reason?: string }) => void) => void;
  'match:input': (input: PlayerInput) => void;
  'match:resync': () => void;
}

export type OnlineSocket = Socket<ServerEvents, ClientEvents>;

export function connectOnline(): OnlineSocket {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  const url = configured ?? `${window.location.protocol}//${window.location.hostname}:3001`;
  return io(url, {
    // WebSocket first, but keep the long-poll fallback: networks that block the
    // upgrade used to look to the player like "server is down".
    transports: ['websocket', 'polling'],
    // Own Manager per attempt: the shared one is cached by URL and used to keep
    // reconnecting (and accumulating listeners) after a socket was thrown away.
    forceNew: true,
    timeout: 8000,
    reconnection: true,
    reconnectionAttempts: 6,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });
}

function toBytes(frame: ArrayBuffer | Uint8Array): Uint8Array {
  if (frame instanceof Uint8Array) return frame;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  // Socket.IO can hand back a Node-style { type: 'Buffer', data: [...] } shape
  // when the transport falls back; accept it rather than crashing the match.
  const maybe = frame as unknown as { data?: number[] };
  if (Array.isArray(maybe?.data)) return Uint8Array.from(maybe.data);
  throw new Error('unrecognised snapshot frame');
}

/**
 * Applies the server's snapshot frames, which are deltas against the previous
 * frame this client received.
 *
 * A frame that cannot be applied (first update after a reconnect, a dropped
 * message, a corrupt payload) returns `null` and clears the baseline. The
 * caller asks the server for a full snapshot and keeps rendering the last good
 * state, so a hiccup costs a few frames of staleness instead of the match.
 */
export class SnapshotStream {
  private baseline: Uint8Array | null = null;

  reset(): void {
    this.baseline = null;
  }

  /** Decoded state, or `null` when a resync is needed. */
  apply(update: MatchUpdate): MatchState | null {
    try {
      const bytes = toBytes(update.snapshot);
      const next = decodeSnapshotFrame(update.full ? null : this.baseline, bytes);
      const state = deserialize(next);
      this.baseline = next;
      return state;
    } catch {
      this.baseline = null;
      return null;
    }
  }
}
