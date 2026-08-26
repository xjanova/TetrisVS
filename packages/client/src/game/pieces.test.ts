import { describe, expect, it } from 'vitest';
import { pieceCells as corePieceCells, type Rotation } from '@tetrisvs/core';
import { pieceCells } from './pieces';
import { offsets } from './renderer';

describe('renderer piece geometry', () => {
  it('uses compact core coordinates for O in every rotation', () => {
    const expected = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (const rotation of [0, 1, 2, 3] as Rotation[]) {
      expect(pieceCells('O', rotation)).toEqual(expected);
    }
  });

  it('maps rendered O cells to the exact cells locked by the core', () => {
    const x = 4;
    const y = 38;
    const rendered = pieceCells('O').map(([dx, dy]) => ({ x: x + dx, y: y + dy }));
    expect(rendered).toEqual(corePieceCells('O', 0, x, y));
  });
});

describe('renderer offset cache', () => {
  it('returns the same coordinates the core locks, for every piece and rotation', () => {
    for (const type of ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const) {
      for (const rotation of [0, 1, 2, 3] as Rotation[]) {
        const cached = offsets(type, rotation).map(([dx, dy]) => ({ x: 4 + dx, y: 38 + dy }));
        expect(cached).toEqual(corePieceCells(type, rotation, 4, 38));
      }
    }
  });

  it('hands back the identical array on a repeat lookup', () => {
    expect(offsets('T', 1)).toBe(offsets('T', 1));
  });
});
