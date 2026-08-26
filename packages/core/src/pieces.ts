/**
 * Piece geometry and SRS kick tables.
 *
 * COORDINATES: `y` grows DOWNWARD (index 0 is the top row of the board).
 * The published SRS tables are written with y-up, so every y in them has been
 * NEGATED here. Getting this wrong is the classic silent Tetris bug — the
 * kick tests in test/srs.test.ts exist specifically to pin it down.
 */

import type { PieceType, Rotation } from './types.js';

/** A cell offset inside the piece bounding box. */
export interface Offset {
  x: number;
  y: number;
}

/** Cells occupied by each piece at each rotation, relative to the bounding box origin. */
export const SHAPES: Record<PieceType, readonly (readonly Offset[])[]> = {
  I: [
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
    [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }],
    [{ x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }],
  ],
  J: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  ],
  L: [
    [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
  O: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  ],
  S: [
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
  T: [
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
  Z: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }],
  ],
};

/** Bounding-box origin at spawn, chosen so every piece starts fully inside the hidden zone. */
export const SPAWN: Record<PieceType, { x: number; y: number }> = {
  I: { x: 3, y: 17 },
  J: { x: 3, y: 18 },
  L: { x: 3, y: 18 },
  O: { x: 4, y: 18 },
  S: { x: 3, y: 18 },
  T: { x: 3, y: 18 },
  Z: { x: 3, y: 18 },
};

/**
 * The T piece's rotation centre inside its bounding box — the cell whose four
 * diagonal neighbours decide a T-spin. For every rotation of T that is (1,1).
 */
export const T_CENTER: Offset = { x: 1, y: 1 };

/**
 * The two "front" corners of the T for each rotation, relative to T_CENTER.
 * Two blocked front corners => full T-spin; one => mini.
 */
export const T_FRONT_CORNERS: Record<Rotation, readonly [Offset, Offset]> = {
  0: [{ x: -1, y: -1 }, { x: 1, y: -1 }],
  1: [{ x: 1, y: -1 }, { x: 1, y: 1 }],
  2: [{ x: -1, y: 1 }, { x: 1, y: 1 }],
  3: [{ x: -1, y: -1 }, { x: -1, y: 1 }],
};

export const T_ALL_CORNERS: readonly Offset[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
];

type KickKey = `${Rotation}>${Rotation}`;

/**
 * SRS wall kicks for J, L, S, T, Z — already converted to y-down.
 * Index 0 is always the no-offset attempt.
 */
export const KICKS_JLSTZ: Record<KickKey, readonly Offset[]> = {
  '0>1': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: 2 }, { x: -1, y: 2 }],
  '1>0': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: -2 }, { x: 1, y: -2 }],
  '1>2': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: -2 }, { x: 1, y: -2 }],
  '2>1': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: 2 }, { x: -1, y: 2 }],
  '2>3': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  '3>2': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -2 }, { x: -1, y: -2 }],
  '3>0': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -2 }, { x: -1, y: -2 }],
  '0>3': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  // 180s are not defined by SRS; this is our own documented table.
  '0>2': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }],
  '2>0': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }],
  '1>3': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }],
  '3>1': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }],
  '0>0': [{ x: 0, y: 0 }],
  '1>1': [{ x: 0, y: 0 }],
  '2>2': [{ x: 0, y: 0 }],
  '3>3': [{ x: 0, y: 0 }],
};

/** SRS wall kicks for I — already converted to y-down. */
export const KICKS_I: Record<KickKey, readonly Offset[]> = {
  '0>1': [{ x: 0, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 1 }, { x: 1, y: -2 }],
  '1>0': [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: -1, y: 0 }, { x: 2, y: -1 }, { x: -1, y: 2 }],
  '1>2': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 2, y: 0 }, { x: -1, y: -2 }, { x: 2, y: 1 }],
  '2>1': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 2 }, { x: -2, y: -1 }],
  '2>3': [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: -1, y: 0 }, { x: 2, y: -1 }, { x: -1, y: 2 }],
  '3>2': [{ x: 0, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 1 }, { x: 1, y: -2 }],
  '3>0': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 2 }, { x: -2, y: -1 }],
  '0>3': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 2, y: 0 }, { x: -1, y: -2 }, { x: 2, y: 1 }],
  '0>2': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }],
  '2>0': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }],
  '1>3': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }],
  '3>1': [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }],
  '0>0': [{ x: 0, y: 0 }],
  '1>1': [{ x: 0, y: 0 }],
  '2>2': [{ x: 0, y: 0 }],
  '3>3': [{ x: 0, y: 0 }],
};

/** O never kicks — it has no rotation offset at all. */
const KICKS_O: readonly Offset[] = [{ x: 0, y: 0 }];

export function kicksFor(type: PieceType, from: Rotation, to: Rotation): readonly Offset[] {
  if (type === 'O') return KICKS_O;
  const key: KickKey = `${from}>${to}`;
  return type === 'I' ? KICKS_I[key] : KICKS_JLSTZ[key];
}

export function rotateCW(r: Rotation): Rotation {
  return ((r + 1) & 3) as Rotation;
}

export function rotateCCW(r: Rotation): Rotation {
  return ((r + 3) & 3) as Rotation;
}

export function rotate180(r: Rotation): Rotation {
  return ((r + 2) & 3) as Rotation;
}

export function cellsOf(type: PieceType, rot: Rotation): readonly Offset[] {
  return SHAPES[type][rot]!;
}
