/**
 * Binary snapshot + hash.
 *
 * `serialize`/`deserialize` are what the server sends to a reconnecting client.
 * `hash` is what both sides exchange periodically to detect desync the tick it
 * happens instead of at the end of the match.
 *
 * The encoding is fixed-layout and endian-explicit so a snapshot produced on
 * one machine decodes identically on another.
 */

import {
  BOARD_CELLS,
  PIECE_TYPES,
  type Board,
  type Cell,
  type GarbageLine,
  type LastAction,
  type MatchState,
  type PieceType,
  type PlayerId,
  type PlayerState,
  type Rotation,
} from './types.js';

const SNAPSHOT_MAGIC = 0x54565331; // "TVS1"

const CELL_TO_BYTE: Record<string, number> = { '0': 0, I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7, G: 8 };
const BYTE_TO_CELL: Cell[] = [0, 'I', 'J', 'L', 'O', 'S', 'T', 'Z', 'G'];

const LAST_ACTIONS: LastAction[] = ['none', 'move', 'rotate', 'softDrop', 'hardDrop', 'hold'];
const STATUSES: MatchState['status'][] = ['countdown', 'playing', 'finished'];

function cellByte(c: Cell): number {
  return CELL_TO_BYTE[String(c)] ?? 0;
}

function pieceByte(p: PieceType | null): number {
  return p === null ? 0 : PIECE_TYPES.indexOf(p) + 1;
}

function bytePiece(b: number): PieceType | null {
  return b === 0 ? null : PIECE_TYPES[b - 1]!;
}

class Writer {
  private buf: number[] = [];

  u8(v: number): void {
    this.buf.push(v & 0xff);
  }

  i8(v: number): void {
    this.buf.push(v & 0xff);
  }

  u16(v: number): void {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff);
  }

  i32(v: number): void {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  u32(v: number): void {
    this.i32(v >>> 0);
  }

  done(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

class Reader {
  private i = 0;

  constructor(private readonly buf: Uint8Array) {}

  u8(): number {
    return this.buf[this.i++]!;
  }

  i8(): number {
    const v = this.buf[this.i++]!;
    return v > 127 ? v - 256 : v;
  }

  u16(): number {
    const v = this.buf[this.i]! | (this.buf[this.i + 1]! << 8);
    this.i += 2;
    return v;
  }

  i32(): number {
    const v =
      (this.buf[this.i]! |
        (this.buf[this.i + 1]! << 8) |
        (this.buf[this.i + 2]! << 16) |
        (this.buf[this.i + 3]! << 24)) |
      0;
    this.i += 4;
    return v;
  }

  u32(): number {
    return this.i32() >>> 0;
  }
}

function writeBoard(w: Writer, board: Board): void {
  for (let i = 0; i < BOARD_CELLS; i++) w.u8(cellByte(board[i]!));
}

function readBoard(r: Reader): Board {
  const board: Board = new Array<Cell>(BOARD_CELLS);
  for (let i = 0; i < BOARD_CELLS; i++) board[i] = BYTE_TO_CELL[r.u8()]!;
  return board;
}

function writePlayer(w: Writer, p: PlayerState): void {
  writeBoard(w, p.board);
  if (p.active === null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u8(pieceByte(p.active.type));
    w.u8(p.active.rot);
    w.i8(p.active.x);
    w.i8(p.active.y);
  }
  w.u8(pieceByte(p.hold));
  w.u8(p.holdUsed ? 1 : 0);
  w.i32(p.bagIndex);
  w.u16(p.garbageQueue.length);
  for (const g of p.garbageQueue) {
    w.u16(g.amount);
    w.u8(g.holeColumn);
    w.i32(g.readyAtFrame);
  }
  w.i32(p.combo);
  w.u8(p.backToBack ? 1 : 0);
  w.i32(p.linesCleared);
  w.i32(p.attackSent);
  w.u8(p.alive ? 1 : 0);
  w.u8(LAST_ACTIONS.indexOf(p.lastAction));
  w.i8(p.lastKickIndex);
  w.i32(p.gravityTicks);
  w.i32(p.lockTicks);
  w.i32(p.lockResets);
  w.i32(p.dasTicks);
  w.i32(p.arrTicks);
  w.i32(p.spawnTicks);
}

function readPlayer(r: Reader): PlayerState {
  const board = readBoard(r);
  const hasActive = r.u8() === 1;
  const active = hasActive
    ? {
        type: bytePiece(r.u8())!,
        rot: r.u8() as Rotation,
        x: r.i8(),
        y: r.i8(),
      }
    : null;
  const hold = bytePiece(r.u8());
  const holdUsed = r.u8() === 1;
  const bagIndex = r.i32();
  const qn = r.u16();
  const garbageQueue: GarbageLine[] = [];
  for (let i = 0; i < qn; i++) {
    garbageQueue.push({ amount: r.u16(), holeColumn: r.u8(), readyAtFrame: r.i32() });
  }
  return {
    board,
    active,
    hold,
    holdUsed,
    bagIndex,
    garbageQueue,
    combo: r.i32(),
    backToBack: r.u8() === 1,
    linesCleared: r.i32(),
    attackSent: r.i32(),
    alive: r.u8() === 1,
    lastAction: LAST_ACTIONS[r.u8()]!,
    lastKickIndex: r.i8(),
    gravityTicks: r.i32(),
    lockTicks: r.i32(),
    lockResets: r.i32(),
    dasTicks: r.i32(),
    arrTicks: r.i32(),
    spawnTicks: r.i32(),
  };
}

export function serialize(state: MatchState): Uint8Array {
  const w = new Writer();
  w.u32(SNAPSHOT_MAGIC);
  w.u8(state.version);
  w.u32(state.seed);
  w.i32(state.frame);
  w.u8(STATUSES.indexOf(state.status));
  w.i8(state.winner === null ? -1 : state.winner);
  writePlayer(w, state.players[0]);
  writePlayer(w, state.players[1]);
  return w.done();
}

export function deserialize(buf: Uint8Array): MatchState {
  const r = new Reader(buf);
  const magic = r.u32();
  if (magic !== SNAPSHOT_MAGIC) {
    throw new Error(`TetrisVS snapshot: bad magic 0x${magic.toString(16)}`);
  }
  const version = r.u8();
  if (version !== 1) {
    throw new Error(`TetrisVS snapshot: unsupported version ${version}`);
  }
  const seed = r.u32();
  const frame = r.i32();
  const status = STATUSES[r.u8()]!;
  const w = r.i8();
  const winner: PlayerId | null = w < 0 ? null : (w as PlayerId);
  const p0 = readPlayer(r);
  const p1 = readPlayer(r);
  return { version: 1, seed, frame, status, winner, players: [p0, p1] };
}

/**
 * FNV-1a over the snapshot bytes. Send this across the wire every N ticks;
 * a mismatch means the two simulations have diverged and one side must be
 * resynced from a snapshot.
 */
export function hash(state: MatchState): number {
  const bytes = serialize(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
