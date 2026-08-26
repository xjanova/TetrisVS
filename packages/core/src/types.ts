/**
 * TetrisVS core — public types and constants.
 *
 * CONTRACT v1.1 — locked 2026-08-14 with codex (BrainX charter note 097b3cae9f4c).
 * Changing anything exported from this file is a BREAKING change for
 * packages/client and packages/server. Announce on topic `tetrisvs` first.
 *
 * DETERMINISM RULES (non-negotiable — the authoritative server replays these
 * exact functions and compares hashes):
 *   - fixed tick, no `dt` anywhere
 *   - integers only on any path that touches state
 *   - no Math.random(), no Date, no wall-clock, no locale-dependent anything
 */

// ---------------------------------------------------------------- constants

/** Simulation rate. Every duration in this codebase is counted in ticks. */
export const TICK_HZ = 60;

/** Playfield width in cells. */
export const BOARD_W = 10;

/** Visible playfield height. */
export const BOARD_H = 20;

/** Total buffer height. The top `BOARD_H_TOTAL - BOARD_H` rows are the hidden spawn zone. */
export const BOARD_H_TOTAL = 40;

/** First visible row index (rows `[0, BOARD_H_HIDDEN)` are hidden). */
export const BOARD_H_HIDDEN = BOARD_H_TOTAL - BOARD_H;

/** How many upcoming pieces the client is expected to preview. */
export const NEXT_COUNT = 5;

/** Cells in one board array. */
export const BOARD_CELLS = BOARD_W * BOARD_H_TOTAL;

// ---------------------------------------------------------------- primitives

export type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z';

export const PIECE_TYPES: readonly PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const;

/** 0 = spawn, 1 = clockwise, 2 = 180, 3 = counter-clockwise. */
export type Rotation = 0 | 1 | 2 | 3;

export type PlayerId = 0 | 1;

/** `0` = empty, a `PieceType` = locked piece of that colour, `'G'` = garbage. */
export type Cell = 0 | PieceType | 'G';

/**
 * Flat playfield, row-major, length `BOARD_CELLS`.
 * Index `y * BOARD_W + x`. Index 0 is the TOP-LEFT cell; `y` grows DOWNWARD.
 */
export type Board = Cell[];

// ---------------------------------------------------------------- input

export type ActionName =
  | 'left'
  | 'right'
  | 'softDrop'
  | 'hardDrop'
  | 'rotCW'
  | 'rotCCW'
  | 'rot180'
  | 'hold';

export interface PlayerInput {
  /** Tick this input belongs to. The server rejects inputs whose frame does not line up. */
  frame: number;
  /** Actions that went down on this exact tick (edge-triggered). */
  pressed: ActionName[];
  /** Actions currently held (level-triggered) — drives DAS/ARR and soft drop. */
  held: ActionName[];
}

export type Inputs = [PlayerInput, PlayerInput];

/** Convenience: an input that does nothing on `frame`. */
export function idleInput(frame: number): PlayerInput {
  return { frame, pressed: [], held: [] };
}

/** Convenience: both players idle on `frame`. */
export function idleInputs(frame: number): Inputs {
  return [idleInput(frame), idleInput(frame)];
}

// ---------------------------------------------------------------- state

export interface ActivePiece {
  type: PieceType;
  rot: Rotation;
  /** x of the piece bounding box's left edge. */
  x: number;
  /** y of the piece bounding box's top edge (grows downward). */
  y: number;
}

export interface GarbageLine {
  amount: number;
  /** Column left empty in every garbage row of this batch. */
  holeColumn: number;
  /** Tick at which this batch becomes eligible to be pushed into the board. */
  readyAtFrame: number;
}

/** What the player last did — required for deterministic T-spin detection. */
export type LastAction = 'none' | 'move' | 'rotate' | 'softDrop' | 'hardDrop' | 'hold';

export interface PlayerState {
  board: Board;
  active: ActivePiece | null;
  hold: PieceType | null;
  holdUsed: boolean;
  /** Number of pieces drawn so far. The next queue is DERIVED from `(seed, bagIndex)`, never stored. */
  bagIndex: number;
  garbageQueue: GarbageLine[];
  /** -1 = no combo running. */
  combo: number;
  backToBack: boolean;
  linesCleared: number;
  attackSent: number;
  alive: boolean;

  /** T-spin bookkeeping. */
  lastAction: LastAction;
  /** Index into the SRS kick table of the kick that succeeded; -1 when the last action was not a rotation. */
  lastKickIndex: number;

  // timers, all in ticks
  gravityTicks: number;
  lockTicks: number;
  lockResets: number;
  dasTicks: number;
  arrTicks: number;
  /** Ticks until the next piece spawns (spawn/ARE delay). */
  spawnTicks: number;
}

export interface MatchState {
  version: 1;
  /** uint32. Both players derive their entire piece sequence from this one number. */
  seed: number;
  frame: number;
  status: 'countdown' | 'playing' | 'finished';
  winner: PlayerId | null;
  players: [PlayerState, PlayerState];
}

// ---------------------------------------------------------------- events

export type ClearKind =
  | 'single'
  | 'double'
  | 'triple'
  | 'tetris'
  | 'tspin-mini'
  | 'tspin-single'
  | 'tspin-double'
  | 'tspin-triple'
  | 'perfect-clear';

/**
 * Everything the render/audio layer needs, emitted the tick it happens.
 * The client never has to diff state frame-by-frame to find out what occurred.
 */
export type CoreEvent =
  | { t: 'countdown'; value: number }
  | { t: 'spawn'; p: PlayerId; piece: PieceType }
  | { t: 'move'; p: PlayerId; dir: -1 | 1 }
  | { t: 'rotate'; p: PlayerId; from: Rotation; to: Rotation; kick: number; tspin: boolean }
  | { t: 'softDrop'; p: PlayerId; cells: number }
  | { t: 'hardDrop'; p: PlayerId; cells: number }
  | { t: 'hold'; p: PlayerId; swapped: PieceType | null }
  | { t: 'holdDenied'; p: PlayerId }
  | { t: 'lock'; p: PlayerId; piece: PieceType; rot: Rotation; x: number; y: number }
  | { t: 'lineClear'; p: PlayerId; rows: number[]; kind: ClearKind; b2b: boolean; combo: number }
  | { t: 'comboUp'; p: PlayerId; combo: number }
  | { t: 'b2bUp'; p: PlayerId }
  | { t: 'b2bBreak'; p: PlayerId }
  | { t: 'attack'; p: PlayerId; to: PlayerId; amount: number; cause: ClearKind }
  | { t: 'garbageIncoming'; p: PlayerId; amount: number; readyAtFrame: number }
  | { t: 'garbageCancelled'; p: PlayerId; amount: number }
  | { t: 'garbageApplied'; p: PlayerId; amount: number; holeColumn: number }
  | { t: 'topout'; p: PlayerId }
  | { t: 'matchEnd'; winner: PlayerId | null };

export interface StepResult {
  state: MatchState;
  events: CoreEvent[];
}

// ---------------------------------------------------------------- config

/**
 * Tunable numbers. NOT part of the state shape on purpose — these can be
 * retuned without breaking the client. Anything here must still be integer
 * ticks or integer counts so determinism holds.
 */
export interface MatchConfig {
  /** Ticks before the piece falls one cell, at the start of the match. */
  gravityTicks: number;
  /** Ticks between gravity ramp steps. `0` freezes gravity at `gravityTicks`. */
  gravityRampEveryTicks: number;
  /** Ticks shaved off the gravity interval at each ramp step. */
  gravityRampStepTicks: number;
  /** Floor for the gravity interval — gravity never gets faster than this. */
  gravityMinTicks: number;
  /** Ticks the piece may rest on the stack before locking. */
  lockDelayTicks: number;
  /** How many times a move/rotate may reset the lock timer. */
  maxLockResets: number;
  /** Delayed Auto Shift: ticks held before auto-repeat starts. */
  dasTicks: number;
  /** Auto Repeat Rate: ticks between auto-repeat steps (0 = instant to wall). */
  arrTicks: number;
  /** Ticks between a lock and the next spawn. */
  spawnDelayTicks: number;
  /** Ticks incoming garbage is telegraphed before it can be pushed in. */
  garbageDelayTicks: number;
  /** Ticks of countdown before `playing` starts. */
  countdownTicks: number;
  /** Cells the piece drops per tick while soft drop is held. */
  softDropCellsPerTick: number;
}

export const DEFAULT_CONFIG: MatchConfig = {
  gravityTicks: 48,
  // Every 30 s the pieces fall a little faster, bottoming out just under four
  // minutes in. Without this a VS match between two competent players had no
  // reason to ever end.
  gravityRampEveryTicks: 30 * TICK_HZ,
  gravityRampStepTicks: 6,
  gravityMinTicks: 4,
  lockDelayTicks: 30,
  maxLockResets: 15,
  dasTicks: 10,
  arrTicks: 2,
  spawnDelayTicks: 6,
  garbageDelayTicks: 60,
  countdownTicks: 180,
  softDropCellsPerTick: 1,
};
