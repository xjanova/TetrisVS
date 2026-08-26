import { describe, expect, it } from 'vitest';
import {
  BOARD_W,
  PIECE_TYPES,
  SHAPES,
  cellsOf,
  collides,
  emptyBoard,
  kicksFor,
  rotate180,
  rotateCCW,
  rotateCW,
  spawnPiece,
  type Rotation,
} from '../src/index.js';

const ROTS: Rotation[] = [0, 1, 2, 3];

describe('piece geometry', () => {
  it('every piece has 4 cells in every rotation', () => {
    for (const t of PIECE_TYPES) {
      for (const r of ROTS) {
        expect(cellsOf(t, r).length, `${t} rot ${r}`).toBe(4);
      }
    }
  });

  it('no duplicate cells within a rotation', () => {
    for (const t of PIECE_TYPES) {
      for (const r of ROTS) {
        const keys = cellsOf(t, r).map((c) => `${c.x},${c.y}`);
        expect(new Set(keys).size, `${t} rot ${r}`).toBe(4);
      }
    }
  });

  it('all offsets stay inside their bounding box', () => {
    for (const t of PIECE_TYPES) {
      const max = t === 'I' ? 4 : t === 'O' ? 2 : 3;
      for (const r of ROTS) {
        for (const c of cellsOf(t, r)) {
          expect(c.x, `${t} rot ${r}`).toBeGreaterThanOrEqual(0);
          expect(c.y, `${t} rot ${r}`).toBeGreaterThanOrEqual(0);
          expect(c.x, `${t} rot ${r}`).toBeLessThan(max);
          expect(c.y, `${t} rot ${r}`).toBeLessThan(max);
        }
      }
    }
  });

  it('O is rotation-invariant', () => {
    const base = JSON.stringify(SHAPES.O[0]);
    for (const r of ROTS) expect(JSON.stringify(SHAPES.O[r])).toBe(base);
  });

  it('rotation helpers cycle correctly', () => {
    for (const r of ROTS) {
      expect(rotateCW(rotateCCW(r))).toBe(r);
      expect(rotateCW(rotateCW(r))).toBe(rotate180(r));
      expect(rotate180(rotate180(r))).toBe(r);
      expect(rotateCW(rotateCW(rotateCW(rotateCW(r))))).toBe(r);
    }
  });

  it('every piece spawns inside the board and above the visible area', () => {
    const board = emptyBoard();
    for (const t of PIECE_TYPES) {
      const p = spawnPiece(t);
      expect(collides(board, p.type, p.rot, p.x, p.y), `${t} spawn collides`).toBe(false);
      for (const c of cellsOf(t, 0)) {
        const ax = p.x + c.x;
        const ay = p.y + c.y;
        expect(ax, `${t} spawn x`).toBeGreaterThanOrEqual(0);
        expect(ax, `${t} spawn x`).toBeLessThan(BOARD_W);
        // hidden zone is rows [0, 20)
        expect(ay, `${t} spawn y`).toBeLessThan(20);
      }
    }
  });
});

describe('SRS kick tables', () => {
  it('the first attempt is always the no-offset one', () => {
    for (const t of PIECE_TYPES) {
      for (const from of ROTS) {
        for (const to of ROTS) {
          const k = kicksFor(t, from, to);
          expect(k.length, `${t} ${from}>${to}`).toBeGreaterThan(0);
          expect(k[0], `${t} ${from}>${to}`).toEqual({ x: 0, y: 0 });
        }
      }
    }
  });

  it('JLSTZ quarter turns offer exactly 5 attempts', () => {
    for (const t of ['J', 'L', 'S', 'T', 'Z'] as const) {
      for (const from of ROTS) {
        const cw = kicksFor(t, from, rotateCW(from));
        const ccw = kicksFor(t, from, rotateCCW(from));
        expect(cw.length, `${t} ${from}>cw`).toBe(5);
        expect(ccw.length, `${t} ${from}>ccw`).toBe(5);
      }
    }
  });

  it('I quarter turns offer exactly 5 attempts', () => {
    for (const from of ROTS) {
      expect(kicksFor('I', from, rotateCW(from)).length).toBe(5);
      expect(kicksFor('I', from, rotateCCW(from)).length).toBe(5);
    }
  });

  it('O never kicks', () => {
    for (const from of ROTS) {
      for (const to of ROTS) {
        expect(kicksFor('O', from, to)).toEqual([{ x: 0, y: 0 }]);
      }
    }
  });

  it('forward and reverse kick tables are mirror images (SRS invariant)', () => {
    // Rotating A->B then B->A must offer exactly negated offsets.
    // `|| 0` normalises -0, which deepEqual would otherwise reject.
    const neg = (n: number) => -n || 0;
    for (const t of ['J', 'L', 'S', 'T', 'Z', 'I'] as const) {
      for (const from of ROTS) {
        const to = rotateCW(from);
        const fwd = kicksFor(t, from, to);
        const rev = kicksFor(t, to, from);
        expect(fwd.length, `${t} ${from}>${to}`).toBe(rev.length);
        for (let i = 0; i < fwd.length; i++) {
          expect({ x: neg(fwd[i]!.x), y: neg(fwd[i]!.y) }, `${t} ${from}>${to} kick ${i}`).toEqual(rev[i]);
        }
      }
    }
  });

  /**
   * These two pin the y-DOWN convention. Published SRS tables are written y-up;
   * every y in ours is negated. A global sign flip would still satisfy the
   * mirror-image test above, so these anchors exist to catch exactly that.
   */
  it('the two-cell vertical kick on JLSTZ 0>R and 0>L moves the piece DOWN', () => {
    for (const t of ['J', 'L', 'S', 'T', 'Z'] as const) {
      const cw = kicksFor(t, 0, 1);
      const ccw = kicksFor(t, 0, 3);
      expect(cw[3], `${t} 0>1`).toEqual({ x: 0, y: 2 });
      expect(cw[4], `${t} 0>1`).toEqual({ x: -1, y: 2 });
      expect(ccw[3], `${t} 0>3`).toEqual({ x: 0, y: 2 });
      expect(ccw[4], `${t} 0>3`).toEqual({ x: 1, y: 2 });
    }
  });

  it('the I piece 0>R kicks are the SRS set converted to y-down', () => {
    expect(kicksFor('I', 0, 1)).toEqual([
      { x: 0, y: 0 },
      { x: -2, y: 0 },
      { x: 1, y: 0 },
      { x: -2, y: 1 },
      { x: 1, y: -2 },
    ]);
  });

  it('kick offsets are integers', () => {
    for (const t of PIECE_TYPES) {
      for (const from of ROTS) {
        for (const to of ROTS) {
          for (const k of kicksFor(t, from, to)) {
            expect(Number.isInteger(k.x)).toBe(true);
            expect(Number.isInteger(k.y)).toBe(true);
          }
        }
      }
    }
  });
});
