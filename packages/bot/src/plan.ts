/**
 * Placement search and the keystrokes to reach it.
 *
 * The bot never writes to the board. It picks a target `(rotation, column)`,
 * turns that into the same `left`/`right`/`rotCW`/`hardDrop` presses a human
 * would send, and lets `step()` do the rest. That is the whole reason an AI
 * match replays like any other: the recorded inputs *are* the bot's decisions,
 * so a replay reproduces them without the bot being present at all.
 */

import {
  BOARD_H_TOTAL,
  BOARD_W,
  cellsOf,
  collides,
  dropDistance,
  idx,
  rotate180,
  rotateCCW,
  rotateCW,
  spawnPiece,
  type ActionName,
  type ActivePiece,
  type Board,
  type PieceType,
  type Rotation,
} from '@tetrisvs/core';
import { copyBoard, measure, score, type EvaluationWeights, type Features } from './evaluate.js';

export interface Placement {
  rotation: Rotation;
  x: number;
  /** Row the piece settled on, for reporting. */
  y: number;
  /** True when this placement is reached by holding first. */
  useHold: boolean;
  value: number;
  features: Features;
  actions: ActionName[];
}

const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];

/** Presses that turn spawn rotation into `target`, shortest path. */
function rotationPresses(from: Rotation, target: Rotation): ActionName[] {
  if (from === target) return [];
  if (rotateCW(from) === target) return ['rotCW'];
  if (rotateCCW(from) === target) return ['rotCCW'];
  if (rotate180(from) === target) return ['rot180'];
  return [];
}

/**
 * Simulate dropping `piece` straight down at (rotation, x) and measure the
 * result. Returns `null` when the piece cannot sit there at all.
 */
function tryPlacement(
  board: Board,
  type: PieceType,
  rotation: Rotation,
  x: number,
  spawnY: number,
  weights: EvaluationWeights,
): { value: number; features: Features; y: number } | null {
  if (collides(board, type, rotation, x, spawnY)) return null;
  const resting: ActivePiece = { type, rot: rotation, x, y: spawnY };
  const drop = dropDistance(board, resting);
  const y = spawnY + drop;

  const cells = cellsOf(type, rotation);
  const scratch = copyBoard(board);
  let lowest = 0;
  const touched: number[] = [];
  for (const offset of cells) {
    const cx = x + offset.x;
    const cy = y + offset.y;
    // A piece that would lock partly above the board is a top-out, not a move.
    if (cy < 0) return null;
    if (cy >= BOARD_H_TOTAL || cx < 0 || cx >= BOARD_W) return null;
    scratch[idx(cx, cy)] = type;
    touched.push(cy);
    if (cy > lowest) lowest = cy;
  }

  // Clear whatever the placement completed, and count how many of the piece's
  // own cells went with it — that is Dellacherie's "eroded" term.
  let cleared = 0;
  let pieceCellsInCleared = 0;
  for (let row = BOARD_H_TOTAL - 1; row >= 0; row--) {
    let full = true;
    for (let column = 0; column < BOARD_W; column++) {
      if (scratch[idx(column, row)] === 0) {
        full = false;
        break;
      }
    }
    if (!full) continue;
    cleared++;
    for (const cy of touched) if (cy === row) pieceCellsInCleared++;
    for (let above = row; above > 0; above--) {
      for (let column = 0; column < BOARD_W; column++) {
        scratch[idx(column, above)] = scratch[idx(column, above - 1)]!;
      }
    }
    for (let column = 0; column < BOARD_W; column++) scratch[idx(column, 0)] = 0;
    row++; // the row index now holds what used to be above it
  }

  const features = measure(scratch, cleared, pieceCellsInCleared, lowest);
  return { value: score(features, weights), features, y };
}

export interface SearchOptions {
  weights: EvaluationWeights;
  /** Consider swapping to the held piece (or pulling the next one) as well. */
  useHold: boolean;
}

/**
 * Every placement the bot can reach by rotating at spawn and sliding sideways.
 *
 * Deliberately no tucks or spins: the piece is dropped straight down from the
 * spawn column, which is what a player tapping left/right then hard-dropping
 * gets. Adding soft-drop slides would strengthen it and is where to look next.
 */
export function candidates(
  board: Board,
  type: PieceType,
  options: SearchOptions,
  useHold = false,
): Placement[] {
  const spawn = spawnPiece(type);
  const out: Placement[] = [];
  const seen = new Set<string>();

  for (const rotation of ROTATIONS) {
    // O never changes shape, and S/Z/I repeat after two — skipping the
    // duplicates halves the search and keeps the choice stable.
    const shapeKey = cellsOf(type, rotation).map((cell) => `${cell.x},${cell.y}`).join(';');
    if (seen.has(shapeKey)) continue;
    seen.add(shapeKey);

    for (let x = -3; x < BOARD_W + 3; x++) {
      const result = tryPlacement(board, type, rotation, x, spawn.y, options.weights);
      if (!result) continue;
      const steps = x - spawn.x;
      const slide: ActionName[] = new Array(Math.abs(steps)).fill(steps < 0 ? 'left' : 'right');
      out.push({
        rotation,
        x,
        y: result.y,
        useHold,
        value: result.value,
        features: result.features,
        actions: [...(useHold ? (['hold'] as ActionName[]) : []), ...rotationPresses(spawn.rot, rotation), ...slide, 'hardDrop'],
      });
    }
  }

  return out;
}

/**
 * Rank every placement for the active piece, and for the piece a hold would
 * bring out. Best first.
 */
export function rankPlacements(
  board: Board,
  active: PieceType,
  holdCandidate: PieceType | null,
  options: SearchOptions,
): Placement[] {
  const all = candidates(board, active, options, false);
  if (options.useHold && holdCandidate && holdCandidate !== active) {
    all.push(...candidates(board, holdCandidate, options, true));
  }
  // Ties broken by fewer keystrokes, so the bot does not wander when two
  // placements are equally good.
  all.sort((a, b) => (b.value - a.value) || (a.actions.length - b.actions.length));
  return all;
}
