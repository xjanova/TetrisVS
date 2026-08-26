/**
 * @tetrisvs/core — deterministic Tetris VS simulation.
 *
 * PUBLIC API (contract v1.1, locked with codex 2026-08-14):
 *   createMatch(seed)                      -> MatchState
 *   step(state, inputs)                    -> { state, events }
 *   nextPieces(seed, bagIndex, count)      -> PieceType[]   (pure)
 *   hash(state)                            -> number        (desync detection)
 *   serialize(state) / deserialize(buf)                     (reconnect)
 *
 * This package imports NOTHING. No DOM, no canvas, no React, no socket, no Web
 * Audio, no Node built-ins. It runs identically in a browser and on the server,
 * which is what makes the authoritative server able to verify clients.
 */

export {
  TICK_HZ,
  BOARD_W,
  BOARD_H,
  BOARD_H_TOTAL,
  BOARD_H_HIDDEN,
  BOARD_CELLS,
  NEXT_COUNT,
  PIECE_TYPES,
  DEFAULT_CONFIG,
  idleInput,
  idleInputs,
} from './types.js';

export type {
  ActionName,
  ActivePiece,
  Board,
  Cell,
  ClearKind,
  CoreEvent,
  GarbageLine,
  Inputs,
  LastAction,
  MatchConfig,
  MatchState,
  PieceType,
  PlayerId,
  PlayerInput,
  PlayerState,
  Rotation,
  StepResult,
} from './types.js';

export { createMatch, step, stepMany, cloneState, detectTSpin, VISIBLE_TOP } from './match.js';
export type { TSpinResult } from './match.js';

export { nextPieces, pieceAt, bagAt, garbageHole, xorshift32, mixSeed } from './rng.js';

export { serialize, deserialize, hash } from './serialize.js';

export {
  emptyBoard,
  getCell,
  isBlocked,
  collides,
  dropDistance,
  ghostPosition,
  pieceCells,
  spawnPiece,
  visibleRows,
  stackTop,
  isBoardEmpty,
  clearFullRows,
  pushGarbage,
  idx,
} from './board.js';

export {
  SHAPES,
  SPAWN,
  cellsOf,
  kicksFor,
  rotateCW,
  rotateCCW,
  rotate180,
  T_CENTER,
  T_FRONT_CORNERS,
  T_ALL_CORNERS,
} from './pieces.js';
export type { Offset } from './pieces.js';

export {
  BASE_ATTACK,
  B2B_BONUS,
  COMBO_TABLE,
  attackFor,
  classifyClear,
  comboBonus,
  isB2BClear,
  breaksB2B,
} from './attack.js';
export type { AttackInput } from './attack.js';
