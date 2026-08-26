import { describe, expect, it } from 'vitest';
import {
  B2B_BONUS,
  BASE_ATTACK,
  attackFor,
  breaksB2B,
  comboBonus,
  isB2BClear,
  type ClearKind,
} from '../src/index.js';

const ALL: ClearKind[] = [
  'single',
  'double',
  'triple',
  'tetris',
  'tspin-mini',
  'tspin-single',
  'tspin-double',
  'tspin-triple',
  'perfect-clear',
];

describe('attack table', () => {
  it('base values are non-negative integers', () => {
    for (const k of ALL) {
      expect(Number.isInteger(BASE_ATTACK[k]), k).toBe(true);
      expect(BASE_ATTACK[k], k).toBeGreaterThanOrEqual(0);
    }
  });

  it('a single sends nothing, a tetris sends four', () => {
    expect(attackFor({ kind: 'single', b2bActive: false, combo: 0, perfectClear: false })).toBe(0);
    expect(attackFor({ kind: 'tetris', b2bActive: false, combo: 0, perfectClear: false })).toBe(4);
  });

  it('T-spins out-damage plain clears of the same line count', () => {
    const plain = attackFor({ kind: 'double', b2bActive: false, combo: 0, perfectClear: false });
    const spin = attackFor({ kind: 'tspin-double', b2bActive: false, combo: 0, perfectClear: false });
    expect(spin).toBeGreaterThan(plain);
  });

  it('back-to-back adds its bonus only to B2B-eligible clears', () => {
    const withB2B = attackFor({ kind: 'tetris', b2bActive: true, combo: 0, perfectClear: false });
    const without = attackFor({ kind: 'tetris', b2bActive: false, combo: 0, perfectClear: false });
    expect(withB2B - without).toBe(B2B_BONUS);

    const dblWith = attackFor({ kind: 'double', b2bActive: true, combo: 0, perfectClear: false });
    const dblWithout = attackFor({ kind: 'double', b2bActive: false, combo: 0, perfectClear: false });
    expect(dblWith).toBe(dblWithout);
  });

  it('combo bonus is monotonic and clamps', () => {
    let prev = -1;
    for (let c = 0; c <= 30; c++) {
      const v = comboBonus(c);
      expect(v).toBeGreaterThanOrEqual(prev === -1 ? 0 : prev);
      prev = v;
    }
    expect(comboBonus(30)).toBe(comboBonus(13));
    expect(comboBonus(0)).toBe(0);
    expect(comboBonus(-5)).toBe(0);
  });

  it('a perfect clear adds a large bonus', () => {
    const pc = attackFor({ kind: 'tetris', b2bActive: false, combo: 0, perfectClear: true });
    const plain = attackFor({ kind: 'tetris', b2bActive: false, combo: 0, perfectClear: false });
    expect(pc - plain).toBe(BASE_ATTACK['perfect-clear']);
  });

  it('never returns a negative or fractional amount', () => {
    for (const kind of ALL) {
      for (const b2b of [false, true]) {
        for (let combo = 0; combo < 20; combo++) {
          const v = attackFor({ kind, b2bActive: b2b, combo, perfectClear: false });
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('classifies which clears sustain and which break back-to-back', () => {
    expect(isB2BClear('tetris')).toBe(true);
    expect(isB2BClear('tspin-double')).toBe(true);
    expect(isB2BClear('tspin-mini')).toBe(true);
    expect(isB2BClear('single')).toBe(false);

    expect(breaksB2B('single')).toBe(true);
    expect(breaksB2B('triple')).toBe(true);
    expect(breaksB2B('tetris')).toBe(false);
    expect(breaksB2B('tspin-single')).toBe(false);
  });
});
