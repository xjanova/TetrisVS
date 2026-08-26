import { describe, expect, it } from 'vitest';
import { pieceCells as corePieceCells, type Rotation } from '@tetrisvs/core';
import { pieceCells } from './pieces';

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
