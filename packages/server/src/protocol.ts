import type { CoreEvent, PlayerId, PlayerInput } from '@tetrisvs/core';

/**
 * Wire contract between client and authoritative server.
 *
 * `match:update.snapshot` is a **snapshot frame**, not a raw snapshot: either a
 * full snapshot or a delta against the previous frame this socket received
 * (see `@tetrisvs/core` `encodeSnapshotFrame`). It travels as binary — Socket.IO
 * sends `Uint8Array` as a binary attachment, so there is no base64 tax.
 *
 * A client that cannot decode a frame must emit `match:resync` and wait; the
 * server answers with a full frame on the next tick. Losing a frame is
 * therefore recoverable and never desyncs the view.
 */

export interface MatchUpdate {
  frame: number;
  /** Desync digest, sent periodically rather than every tick. `null` on the other ticks. */
  hash: number | null;
  events: CoreEvent[];
  /** Full snapshot or delta — see `isFullFrame`. */
  snapshot: Uint8Array;
  /** True when `snapshot` needs no baseline. Convenience mirror of `isFullFrame`. */
  full: boolean;
}

export interface ClientToServerEvents {
  'matchmaking:join': (pool: string, reply: (result: { searching: boolean }) => void) => void;
  'matchmaking:cancel': (reply: (result: { cancelled: boolean }) => void) => void;
  'room:create': (reply: (result: { roomCode: string; playerId: PlayerId }) => void) => void;
  'room:join': (roomCode: string, reply: (result: { ok: boolean; playerId?: PlayerId; reason?: string }) => void) => void;
  'match:input': (input: PlayerInput) => void;
  /** "I could not apply the last delta — send me a full snapshot." */
  'match:resync': () => void;
}

export interface ServerToClientEvents {
  'matchmaking:searching': () => void;
  'matchmaking:matched': (result: { roomCode: string; playerId: PlayerId }) => void;
  'room:ready': (roomCode: string) => void;
  'match:update': (update: MatchUpdate) => void;
  'match:ended': (winner: PlayerId | null, reason: EndReason) => void;
  'peer:disconnected': () => void;
}

/** Why a match stopped. `forfeit` means the opponent left a live match. */
export type EndReason = 'topout' | 'forfeit';

export interface SocketData {
  roomCode?: string;
  playerId?: PlayerId;
}
