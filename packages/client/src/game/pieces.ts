import { cellsOf, type PieceType, type Rotation } from '@tetrisvs/core';

export const PIECE_COLORS: Record<PieceType, string> = {
  I: '#25e5ff',
  J: '#5476ff',
  L: '#ff9e2c',
  O: '#ffe23b',
  S: '#62ef78',
  T: '#bc5cff',
  Z: '#ff4f70',
};

/**
 * The renderer derives offsets from the deterministic core instead of keeping
 * a second shape table. Active, ghost, collision, and locked cells therefore
 * always share one coordinate system.
 */
export function pieceCells(type: PieceType, rotation: Rotation = 0): ReadonlyArray<readonly [number, number]> {
  return cellsOf(type, rotation).map(({ x, y }) => [x, y] as const);
}
