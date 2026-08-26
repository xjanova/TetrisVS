/**
 * The simulation. `step()` is a pure function of (state, inputs) — same inputs
 * in, byte-identical state out, on any machine. That property is what makes the
 * authoritative server possible: it replays this exact code and compares hashes.
 *
 * There is deliberately no `dt` parameter. Everything is counted in ticks.
 */

import {
  BOARD_H_HIDDEN,
  BOARD_W,
  DEFAULT_CONFIG,
  TICK_HZ,
  type ActionName,
  type ActivePiece,
  type ClearKind,
  type CoreEvent,
  type GarbageLine,
  type Inputs,
  type LastAction,
  type MatchConfig,
  type MatchState,
  type PieceType,
  type PlayerId,
  type PlayerInput,
  type PlayerState,
  type Rotation,
  type StepResult,
} from './types.js';
import {
  clearFullRows,
  collides,
  dropDistance,
  emptyBoard,
  isBlocked,
  isBoardEmpty,
  lockPiece,
  pushGarbage,
  spawnPiece,
} from './board.js';
import { kicksFor, rotate180, rotateCCW, rotateCW, T_ALL_CORNERS, T_CENTER, T_FRONT_CORNERS } from './pieces.js';
import { garbageHole, pieceAt } from './rng.js';
import { attackFor, breaksB2B, classifyClear, isB2BClear } from './attack.js';

// ---------------------------------------------------------------- construction

function newPlayer(config: MatchConfig): PlayerState {
  return {
    board: emptyBoard(),
    active: null,
    hold: null,
    holdUsed: false,
    bagIndex: 0,
    garbageQueue: [],
    combo: -1,
    backToBack: false,
    linesCleared: 0,
    attackSent: 0,
    alive: true,
    lastAction: 'none',
    lastKickIndex: -1,
    gravityTicks: 0,
    lockTicks: 0,
    lockResets: 0,
    dasTicks: 0,
    arrTicks: 0,
    spawnTicks: config.spawnDelayTicks,
  };
}

export function createMatch(seed: number, config: MatchConfig = DEFAULT_CONFIG): MatchState {
  return {
    version: 1,
    seed: seed >>> 0,
    frame: 0,
    status: 'countdown',
    winner: null,
    players: [newPlayer(config), newPlayer(config)],
  };
}

// ---------------------------------------------------------------- cloning

function clonePlayer(p: PlayerState): PlayerState {
  return {
    board: p.board.slice(),
    active: p.active ? { ...p.active } : null,
    hold: p.hold,
    holdUsed: p.holdUsed,
    bagIndex: p.bagIndex,
    garbageQueue: p.garbageQueue.map((g) => ({ ...g })),
    combo: p.combo,
    backToBack: p.backToBack,
    linesCleared: p.linesCleared,
    attackSent: p.attackSent,
    alive: p.alive,
    lastAction: p.lastAction,
    lastKickIndex: p.lastKickIndex,
    gravityTicks: p.gravityTicks,
    lockTicks: p.lockTicks,
    lockResets: p.lockResets,
    dasTicks: p.dasTicks,
    arrTicks: p.arrTicks,
    spawnTicks: p.spawnTicks,
  };
}

export function cloneState(s: MatchState): MatchState {
  return {
    version: s.version,
    seed: s.seed,
    frame: s.frame,
    status: s.status,
    winner: s.winner,
    players: [clonePlayer(s.players[0]), clonePlayer(s.players[1])],
  };
}

// ---------------------------------------------------------------- helpers

function has(list: readonly ActionName[], a: ActionName): boolean {
  return list.indexOf(a) !== -1;
}

/** A pending attack produced this tick, delivered after both players have been stepped. */
interface PendingAttack {
  from: PlayerId;
  amount: number;
  cause: ClearKind;
}

function setLast(p: PlayerState, action: LastAction, kickIndex: number): void {
  p.lastAction = action;
  p.lastKickIndex = kickIndex;
}

/**
 * Gravity interval for a given tick.
 *
 * Pure and integer-only, so both sides of a match derive the same value from
 * `frame` alone — no timer, no level counter to keep in sync, nothing extra in
 * the snapshot.
 */
export function gravityAt(frame: number, config: MatchConfig = DEFAULT_CONFIG): number {
  if (config.gravityRampEveryTicks <= 0 || config.gravityRampStepTicks <= 0) return config.gravityTicks;
  const steps = Math.floor(Math.max(0, frame) / config.gravityRampEveryTicks);
  const interval = config.gravityTicks - steps * config.gravityRampStepTicks;
  return Math.max(config.gravityMinTicks, interval);
}

/** 1-based difficulty step, purely for display. */
export function levelAt(frame: number, config: MatchConfig = DEFAULT_CONFIG): number {
  if (config.gravityRampEveryTicks <= 0) return 1;
  const steps = Math.floor(Math.max(0, frame) / config.gravityRampEveryTicks);
  const maxSteps = config.gravityRampStepTicks > 0
    ? Math.ceil((config.gravityTicks - config.gravityMinTicks) / config.gravityRampStepTicks)
    : 0;
  return Math.min(steps, maxSteps) + 1;
}

/** Reset the lock timer after a successful move/rotate, if resets remain. */
function tryResetLock(p: PlayerState, config: MatchConfig): void {
  if (p.lockTicks > 0 && p.lockResets < config.maxLockResets) {
    p.lockTicks = 0;
    p.lockResets++;
  }
}

// ---------------------------------------------------------------- T-spin

export interface TSpinResult {
  tspin: boolean;
  mini: boolean;
}

/**
 * Deterministic T-spin test, evaluated at lock time.
 *
 * A T-spin requires: the piece is a T, the last successful action was a
 * rotation, and at least 3 of the 4 diagonal corners around the T's centre are
 * blocked (walls and floor count as blocked).
 *
 * Full vs mini: 2 blocked FRONT corners => full. Otherwise mini, except that
 * the final SRS kick (index 4) always promotes to full — that is the standard
 * exception that makes T-spin triples work.
 */
export function detectTSpin(p: PlayerState, piece: ActivePiece): TSpinResult {
  if (piece.type !== 'T' || p.lastAction !== 'rotate') return { tspin: false, mini: false };

  const cx = piece.x + T_CENTER.x;
  const cy = piece.y + T_CENTER.y;

  let blocked = 0;
  for (const o of T_ALL_CORNERS) {
    if (isBlocked(p.board, cx + o.x, cy + o.y)) blocked++;
  }
  if (blocked < 3) return { tspin: false, mini: false };

  const front = T_FRONT_CORNERS[piece.rot];
  let frontBlocked = 0;
  for (const o of front) {
    if (isBlocked(p.board, cx + o.x, cy + o.y)) frontBlocked++;
  }

  const full = frontBlocked >= 2 || p.lastKickIndex === 4;
  return { tspin: true, mini: !full };
}

// ---------------------------------------------------------------- garbage

/** Cancel up to `amount` of this player's pending garbage. Returns what is left to send. */
function cancelIncoming(p: PlayerState, amount: number, out: CoreEvent[], id: PlayerId): number {
  let remaining = amount;
  let cancelled = 0;
  while (remaining > 0 && p.garbageQueue.length > 0) {
    const head = p.garbageQueue[0]!;
    const take = Math.min(head.amount, remaining);
    head.amount -= take;
    remaining -= take;
    cancelled += take;
    if (head.amount === 0) p.garbageQueue.shift();
  }
  if (cancelled > 0) out.push({ t: 'garbageCancelled', p: id, amount: cancelled });
  return remaining;
}

/** Push every batch whose telegraph has elapsed into the board. */
function applyReadyGarbage(
  p: PlayerState,
  id: PlayerId,
  frame: number,
  out: CoreEvent[],
): void {
  while (p.garbageQueue.length > 0) {
    const head = p.garbageQueue[0]!;
    if (head.readyAtFrame > frame) break;
    p.garbageQueue.shift();
    if (head.amount <= 0) continue;
    pushGarbage(p.board, head.amount, head.holeColumn);
    out.push({ t: 'garbageApplied', p: id, amount: head.amount, holeColumn: head.holeColumn });
  }
}

// ---------------------------------------------------------------- piece lifecycle

function spawnNext(
  state: MatchState,
  p: PlayerState,
  id: PlayerId,
  out: CoreEvent[],
  forced?: PieceType,
): void {
  const type = forced ?? pieceAt(state.seed, p.bagIndex);
  if (forced === undefined) p.bagIndex++;
  const piece = spawnPiece(type);
  p.active = piece;
  p.holdUsed = false;
  p.gravityTicks = 0;
  p.lockTicks = 0;
  p.lockResets = 0;
  setLast(p, 'none', -1);
  out.push({ t: 'spawn', p: id, piece: type });

  if (collides(p.board, piece.type, piece.rot, piece.x, piece.y)) {
    p.alive = false;
    p.active = null;
    out.push({ t: 'topout', p: id });
  }
}

function tryMove(p: PlayerState, dx: number, dy: number): boolean {
  const a = p.active;
  if (!a) return false;
  if (collides(p.board, a.type, a.rot, a.x + dx, a.y + dy)) return false;
  a.x += dx;
  a.y += dy;
  return true;
}

function tryRotate(p: PlayerState, to: Rotation, id: PlayerId, out: CoreEvent[], config: MatchConfig): boolean {
  const a = p.active;
  if (!a) return false;
  const from = a.rot;
  if (from === to) return false;
  const kicks = kicksFor(a.type, from, to);
  for (let i = 0; i < kicks.length; i++) {
    const k = kicks[i]!;
    const nx = a.x + k.x;
    const ny = a.y + k.y;
    if (!collides(p.board, a.type, to, nx, ny)) {
      a.rot = to;
      a.x = nx;
      a.y = ny;
      setLast(p, 'rotate', i);
      tryResetLock(p, config);
      const ts = detectTSpin(p, a);
      out.push({ t: 'rotate', p: id, from, to, kick: i, tspin: ts.tspin });
      return true;
    }
  }
  return false;
}

function doHold(state: MatchState, p: PlayerState, id: PlayerId, out: CoreEvent[]): void {
  const a = p.active;
  if (!a) return;
  if (p.holdUsed) {
    out.push({ t: 'holdDenied', p: id });
    return;
  }
  const swapped = p.hold;
  p.hold = a.type;
  p.holdUsed = true;
  out.push({ t: 'hold', p: id, swapped });
  if (swapped === null) {
    spawnNext(state, p, id, out);
  } else {
    spawnNext(state, p, id, out, swapped);
  }
  // spawnNext resets holdUsed; a hold must stay spent until the piece locks.
  p.holdUsed = true;
  setLast(p, 'hold', -1);
}

/** Resolve a lock: stamp, clear, score, and hand back any attack produced. */
function resolveLock(
  state: MatchState,
  p: PlayerState,
  id: PlayerId,
  out: CoreEvent[],
  config: MatchConfig,
  pending: PendingAttack[],
): void {
  const a = p.active!;
  const ts = detectTSpin(p, a);

  lockPiece(p.board, a);
  out.push({ t: 'lock', p: id, piece: a.type, rot: a.rot, x: a.x, y: a.y });
  p.active = null;

  const rows = clearFullRows(p.board);
  const lines = rows.length;

  if (lines > 0) {
    p.linesCleared += lines;
    p.combo++;
    const perfect = isBoardEmpty(p.board);
    const kind = classifyClear(lines, ts.tspin, ts.mini)!;

    const wasB2B = p.backToBack;
    if (isB2BClear(kind)) {
      if (!wasB2B) {
        p.backToBack = true;
        out.push({ t: 'b2bUp', p: id });
      }
    } else if (breaksB2B(kind) && wasB2B) {
      p.backToBack = false;
      out.push({ t: 'b2bBreak', p: id });
    }

    out.push({ t: 'lineClear', p: id, rows, kind, b2b: wasB2B, combo: p.combo });
    if (p.combo > 0) out.push({ t: 'comboUp', p: id, combo: p.combo });

    const amount = attackFor({ kind, b2bActive: wasB2B, combo: p.combo, perfectClear: perfect });
    if (amount > 0) {
      const left = cancelIncoming(p, amount, out, id);
      if (left > 0) {
        p.attackSent += left;
        pending.push({ from: id, amount: left, cause: kind });
      }
    }
  } else {
    p.combo = -1;
    // Garbage only lands when you fail to clear.
    applyReadyGarbage(p, id, state.frame, out);
  }

  p.spawnTicks = config.spawnDelayTicks;
  setLast(p, 'none', -1);
}

// ---------------------------------------------------------------- per-player tick

function stepPlayer(
  state: MatchState,
  id: PlayerId,
  input: PlayerInput,
  out: CoreEvent[],
  config: MatchConfig,
  pending: PendingAttack[],
): void {
  const p = state.players[id];
  if (!p.alive) return;

  if (p.active === null) {
    if (p.spawnTicks > 0) {
      p.spawnTicks--;
      return;
    }
    spawnNext(state, p, id, out);
    if (!p.alive) return;
  }

  // ---- hold (consumes the tick's other actions for this piece intentionally not:
  //      hold swaps the piece, further actions apply to the new piece next tick)
  if (has(input.pressed, 'hold')) {
    doHold(state, p, id, out);
    if (!p.alive || p.active === null) return;
  }

  // ---- rotation
  if (has(input.pressed, 'rotCW')) tryRotate(p, rotateCW(p.active!.rot), id, out, config);
  if (has(input.pressed, 'rotCCW')) tryRotate(p, rotateCCW(p.active!.rot), id, out, config);
  if (has(input.pressed, 'rot180')) tryRotate(p, rotate180(p.active!.rot), id, out, config);

  // ---- horizontal movement with DAS / ARR
  const leftHeld = has(input.held, 'left');
  const rightHeld = has(input.held, 'right');
  const leftTap = has(input.pressed, 'left');
  const rightTap = has(input.pressed, 'right');

  // Both directions held cancel out — deterministic and avoids a jitter loop.
  const dir: -1 | 0 | 1 = leftHeld && rightHeld ? 0 : leftHeld ? -1 : rightHeld ? 1 : 0;
  const tapped = (leftTap && !rightTap) || (rightTap && !leftTap);

  if (dir === 0) {
    p.dasTicks = 0;
    p.arrTicks = 0;
  } else {
    if (tapped) {
      p.dasTicks = 0;
      p.arrTicks = 0;
      if (tryMove(p, dir, 0)) {
        setLast(p, 'move', -1);
        tryResetLock(p, config);
        out.push({ t: 'move', p: id, dir });
      }
    } else {
      p.dasTicks++;
      if (p.dasTicks >= config.dasTicks) {
        if (config.arrTicks <= 0) {
          // Instant ARR: slide to the wall.
          let moved = 0;
          while (tryMove(p, dir, 0)) moved++;
          if (moved > 0) {
            setLast(p, 'move', -1);
            tryResetLock(p, config);
            out.push({ t: 'move', p: id, dir });
          }
        } else {
          p.arrTicks++;
          if (p.arrTicks >= config.arrTicks) {
            p.arrTicks = 0;
            if (tryMove(p, dir, 0)) {
              setLast(p, 'move', -1);
              tryResetLock(p, config);
              out.push({ t: 'move', p: id, dir });
            }
          }
        }
      }
    }
  }

  // ---- hard drop: resolves immediately, ends the piece
  if (has(input.pressed, 'hardDrop')) {
    const d = dropDistance(p.board, p.active!);
    if (d > 0) {
      p.active!.y += d;
      setLast(p, 'hardDrop', -1);
    }
    out.push({ t: 'hardDrop', p: id, cells: d });
    resolveLock(state, p, id, out, config, pending);
    return;
  }

  // ---- gravity / soft drop
  const soft = has(input.held, 'softDrop');
  if (soft) {
    let dropped = 0;
    for (let i = 0; i < config.softDropCellsPerTick; i++) {
      if (tryMove(p, 0, 1)) dropped++;
      else break;
    }
    if (dropped > 0) {
      setLast(p, 'softDrop', -1);
      p.gravityTicks = 0;
      out.push({ t: 'softDrop', p: id, cells: dropped });
    }
  } else {
    p.gravityTicks++;
    if (p.gravityTicks >= gravityAt(state.frame, config)) {
      p.gravityTicks = 0;
      tryMove(p, 0, 1);
    }
  }

  // ---- lock delay
  const resting = collides(p.board, p.active!.type, p.active!.rot, p.active!.x, p.active!.y + 1);
  if (resting) {
    p.lockTicks++;
    if (p.lockTicks >= config.lockDelayTicks) {
      resolveLock(state, p, id, out, config, pending);
    }
  } else {
    p.lockTicks = 0;
  }
}

// ---------------------------------------------------------------- public step

/**
 * Advance the match by exactly one tick.
 *
 * PURE: `state` is never mutated; a new state is returned. Given the same
 * `(state, inputs, config)` this always produces the same result — that is the
 * property the authoritative server and any rollback netcode depend on.
 *
 * @param config optional tuning. Omit it and DEFAULT_CONFIG is used. Both sides
 *               of a match MUST pass the same config or they will desync.
 */
export function step(state: MatchState, inputs: Inputs, config: MatchConfig = DEFAULT_CONFIG): StepResult {
  const s = cloneState(state);
  const events: CoreEvent[] = [];

  if (s.status === 'finished') return { state: s, events };

  if (s.status === 'countdown') {
    const remaining = config.countdownTicks - s.frame;
    if (remaining > 0) {
      if (remaining % TICK_HZ === 0) {
        events.push({ t: 'countdown', value: Math.ceil(remaining / TICK_HZ) });
      }
      s.frame++;
      return { state: s, events };
    }
    s.status = 'playing';
    events.push({ t: 'countdown', value: 0 });
  }

  const pending: PendingAttack[] = [];

  // Fixed player order — never iterate a Set or Object.keys here.
  stepPlayer(s, 0, inputs[0], events, config, pending);
  stepPlayer(s, 1, inputs[1], events, config, pending);

  // Deliver attacks after BOTH players have been stepped, so a tick is symmetric:
  // simultaneous clears cancel each other rather than depending on player order.
  for (const atk of pending) {
    const target: PlayerId = atk.from === 0 ? 1 : 0;
    const victim = s.players[target];
    if (!victim.alive) continue;
    const left = cancelIncoming(victim, atk.amount, events, target);
    events.push({ t: 'attack', p: atk.from, to: target, amount: atk.amount, cause: atk.cause });
    if (left > 0) {
      const line: GarbageLine = {
        amount: left,
        holeColumn: garbageHole(s.seed, s.players[atk.from].attackSent + s.frame, BOARD_W),
        readyAtFrame: s.frame + config.garbageDelayTicks,
      };
      victim.garbageQueue.push(line);
      events.push({
        t: 'garbageIncoming',
        p: target,
        amount: line.amount,
        readyAtFrame: line.readyAtFrame,
      });
    }
  }

  // ---- win condition
  const dead0 = !s.players[0].alive;
  const dead1 = !s.players[1].alive;
  if (dead0 || dead1) {
    s.status = 'finished';
    s.winner = dead0 && dead1 ? null : dead0 ? 1 : 0;
    events.push({ t: 'matchEnd', winner: s.winner });
  }

  s.frame++;
  return { state: s, events };
}

/** Convenience for tests and for the server's catch-up loop. */
export function stepMany(
  state: MatchState,
  inputsPerTick: readonly Inputs[],
  config: MatchConfig = DEFAULT_CONFIG,
): StepResult {
  let cur = state;
  const events: CoreEvent[] = [];
  for (const inputs of inputsPerTick) {
    const r = step(cur, inputs, config);
    cur = r.state;
    for (const e of r.events) events.push(e);
  }
  return { state: cur, events };
}

/** First visible row index — exported for the renderer's convenience. */
export const VISIBLE_TOP = BOARD_H_HIDDEN;
