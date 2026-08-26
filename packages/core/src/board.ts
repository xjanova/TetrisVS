/**
 * Playfield primitives. Pure helpers, no state ownership.
 */

import {
  BOARD_CELLS,
  BOARD_H_HIDDEN,
  BOARD_H_TOTAL,
  BOARD_W,
  type ActivePiece,
  type Board,
  type Cell,
  type PieceType,
  type Rotation,
} from './types.js';
import { cellsOf, SPAWN } from './pieces.js';

export function emptyBoard(): Board {
  return new Array<Cell>(BOARD_CELLS).fill(0);
}

export function idx(x: number, y: number): number {
  return y * BOARD_W + x;
}

export function getCell(board: Board, x: number, y: number): Cell {
  if (x < 0 || x >= BOARD_W || y < 0 || y >= BOARD_H_TOTAL) return 0;
  return board[idx(x, y)]!;
}

/** Outside the playfield counts as solid — used by collision and T-spin corner checks. */
export function isBlocked(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= BOARD_W) return true;
  if (y >= BOARD_H_TOTAL) return true;
  if (y < 0) return false; // above the buffer is open air
  return board[idx(x, y)] !== 0;
}

/** Absolute cells a piece occupies at a given position. */
export function pieceCells(type: PieceType, rot: Rotation, x: number, y: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const o of cellsOf(type, rot)) {
    out.push({ x: x + o.x, y: y + o.y });
  }
  return out;
}

export function collides(board: Board, type: PieceType, rot: Rotation, x: number, y: number): boolean {
  for (const c of pieceCells(type, rot, x, y)) {
    if (isBlocked(board, c.x, c.y)) return true;
  }
  return false;
}

export function spawnPiece(type: PieceType): ActivePiece {
  const s = SPAWN[type];
  return { type, rot: 0, x: s.x, y: s.y };
}

/** How far straight down the piece can travel before colliding. */
export function dropDistance(board: Board, p: ActivePiece): number {
  let d = 0;
  while (!collides(board, p.type, p.rot, p.x, p.y + d + 1)) d++;
  return d;
}

/** The piece's resting position if hard-dropped now — the client uses this for the ghost. */
export function ghostPosition(board: Board, p: ActivePiece): ActivePiece {
  return { ...p, y: p.y + dropDistance(board, p) };
}

/** Stamp the piece into the board. Mutates `board`. */
export function lockPiece(board: Board, p: ActivePiece): void {
  for (const c of pieceCells(p.type, p.rot, p.x, p.y)) {
    if (c.y >= 0 && c.y < BOARD_H_TOTAL && c.x >= 0 && c.x < BOARD_W) {
      board[idx(c.x, c.y)] = p.type;
    }
  }
}

export function rowIsFull(board: Board, y: number): boolean {
  for (let x = 0; x < BOARD_W; x++) {
    if (board[idx(x, y)] === 0) return false;
  }
  return true;
}

export function rowIsEmpty(board: Board, y: number): boolean {
  for (let x = 0; x < BOARD_W; x++) {
    if (board[idx(x, y)] !== 0) return false;
  }
  return true;
}

/** Remove every full row, collapse the rest down. Returns the cleared row indices, top-first. */
export function clearFullRows(board: Board): number[] {
  const cleared: number[] = [];
  for (let y = 0; y < BOARD_H_TOTAL; y++) {
    if (rowIsFull(board, y)) cleared.push(y);
  }
  if (cleared.length === 0) return cleared;

  const kept: Cell[] = [];
  const clearedSet = new Set(cleared);
  for (let y = 0; y < BOARD_H_TOTAL; y++) {
    if (clearedSet.has(y)) continue;
    for (let x = 0; x < BOARD_W; x++) kept.push(board[idx(x, y)]!);
  }
  const pad = cleared.length * BOARD_W;
  for (let i = 0; i < pad; i++) board[i] = 0;
  for (let i = 0; i < kept.length; i++) board[pad + i] = kept[i]!;
  return cleared;
}

/** True when the whole playfield is empty — a perfect clear. */
export function isBoardEmpty(board: Board): boolean {
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board[i] !== 0) return false;
  }
  return true;
}

/**
 * Push `amount` garbage rows in from the bottom, each with a hole at `holeColumn`.
 * Rows shifted off the top are discarded (they were above the buffer anyway).
 * Mutates `board`.
 */
export function pushGarbage(board: Board, amount: number, holeColumn: number): void {
  if (amount <= 0) return;
  const n = Math.min(amount, BOARD_H_TOTAL);
  const shift = n * BOARD_W;
  // Move everything up by n rows.
  for (let i = 0; i < BOARD_CELLS - shift; i++) {
    board[i] = board[i + shift]!;
  }
  // Fill the bottom n rows with garbage.
  for (let r = 0; r < n; r++) {
    const y = BOARD_H_TOTAL - 1 - r;
    for (let x = 0; x < BOARD_W; x++) {
      board[idx(x, y)] = x === holeColumn ? 0 : 'G';
    }
  }
}

/** Highest occupied row index, or BOARD_H_TOTAL when the board is empty. */
export function stackTop(board: Board): number {
  for (let y = 0; y < BOARD_H_TOTAL; y++) {
    if (!rowIsEmpty(board, y)) return y;
  }
  return BOARD_H_TOTAL;
}

/** Visible-area view for the renderer: the bottom `BOARD_H` rows. */
export function visibleRows(board: Board): Cell[][] {
  const rows: Cell[][] = [];
  for (let y = BOARD_H_HIDDEN; y < BOARD_H_TOTAL; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < BOARD_W; x++) row.push(board[idx(x, y)]!);
    rows.push(row);
  }
  return rows;
}
