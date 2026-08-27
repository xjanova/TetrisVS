/**
 * Board evaluation.
 *
 * Six features, weighted — the shape Pierre Dellacherie published and which is
 * still the strongest thing you can write without search or learning. The
 * weights below are his; they are not tuned guesses and should not be nudged
 * without measuring, because they trade off against each other.
 *
 * Everything here is pure and reads a board it does not own. Floats are fine:
 * the bot never touches `MatchState`, it only produces *inputs*, and inputs are
 * what the simulation and the replay actually record. Nothing about the game's
 * determinism runs through this file.
 */

import { BOARD_H_TOTAL, BOARD_W, idx, type Board, type Cell } from '@tetrisvs/core';

export interface EvaluationWeights {
  landingHeight: number;
  erodedPieceCells: number;
  rowTransitions: number;
  columnTransitions: number;
  holes: number;
  wellSums: number;
}

/** Dellacherie's published weights. Strong enough to clear lines indefinitely. */
export const DELLACHERIE: EvaluationWeights = {
  landingHeight: -4.500158825082766,
  erodedPieceCells: 3.4181268101392694,
  rowTransitions: -3.2178882868487753,
  columnTransitions: -9.348695305445199,
  holes: -7.899265427351652,
  wellSums: -3.3855972247263626,
};

export interface Features {
  landingHeight: number;
  erodedPieceCells: number;
  rowTransitions: number;
  columnTransitions: number;
  holes: number;
  wellSums: number;
  /** Rows the placement cleared — used for difficulty shaping, not by Dellacherie. */
  linesCleared: number;
  /** Highest occupied row, as a height above the floor. Used for panic checks. */
  stackHeight: number;
}

function filled(board: Board, x: number, y: number): boolean {
  // Walls and floor count as filled; the ceiling does not. That asymmetry is
  // what makes row/column transitions measure "raggedness" rather than "height".
  if (x < 0 || x >= BOARD_W) return true;
  if (y >= BOARD_H_TOTAL) return true;
  if (y < 0) return false;
  return board[idx(x, y)] !== 0;
}

/**
 * Score a board that already has the piece locked into it.
 *
 * @param cleared rows the placement cleared (already removed from `board`)
 * @param pieceCellsInCleared how many of the piece's own cells were in them
 * @param landingRow the row the piece's lowest cell came to rest on
 */
export function measure(
  board: Board,
  cleared: number,
  pieceCellsInCleared: number,
  landingRow: number,
): Features {
  let rowTransitions = 0;
  let columnTransitions = 0;
  let holes = 0;
  let wellSums = 0;
  let top = BOARD_H_TOTAL;

  for (let y = 0; y < BOARD_H_TOTAL; y++) {
    let previous = true; // the left wall
    let rowHasContent = false;
    for (let x = 0; x < BOARD_W; x++) {
      const here = filled(board, x, y);
      if (here) rowHasContent = true;
      if (here !== previous) rowTransitions++;
      previous = here;
    }
    if (!previous) rowTransitions++; // the right wall
    if (rowHasContent && y < top) top = y;
  }

  for (let x = 0; x < BOARD_W; x++) {
    let previous = false; // open sky above the board
    let seenFilled = false;
    for (let y = 0; y < BOARD_H_TOTAL; y++) {
      const here = filled(board, x, y);
      if (here !== previous) columnTransitions++;
      if (here) seenFilled = true;
      else if (seenFilled) holes++;
      previous = here;
    }
    if (!previous) columnTransitions++; // the floor
  }

  // A well is a run of empty cells with filled neighbours on both sides. Deeper
  // wells cost quadratically, which is what stops the bot digging a canyon it
  // can only fill with an I piece.
  for (let x = 0; x < BOARD_W; x++) {
    let depth = 0;
    for (let y = 0; y < BOARD_H_TOTAL; y++) {
      const open = !filled(board, x, y);
      const walled = filled(board, x - 1, y) && filled(board, x + 1, y);
      if (open && walled) {
        depth++;
        wellSums += depth;
      } else if (!open) {
        depth = 0;
      }
    }
  }

  return {
    // Measured from the floor so "higher is worse" reads the obvious way.
    landingHeight: BOARD_H_TOTAL - landingRow,
    erodedPieceCells: cleared * pieceCellsInCleared,
    rowTransitions,
    columnTransitions,
    holes,
    wellSums,
    linesCleared: cleared,
    stackHeight: BOARD_H_TOTAL - top,
  };
}

export function score(features: Features, weights: EvaluationWeights): number {
  return (
    features.landingHeight * weights.landingHeight +
    features.erodedPieceCells * weights.erodedPieceCells +
    features.rowTransitions * weights.rowTransitions +
    features.columnTransitions * weights.columnTransitions +
    features.holes * weights.holes +
    features.wellSums * weights.wellSums
  );
}

/** Scratch copy so callers never mutate the state they were handed. */
export function copyBoard(board: Board): Cell[] {
  return board.slice();
}
