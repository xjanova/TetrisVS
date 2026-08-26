import { describe, expect, it, vi } from 'vitest';
import { WriteQueue } from '../src/index.js';

describe('WriteQueue', () => {
  it('holds items until drained', () => {
    const batches: number[][] = [];
    const queue = new WriteQueue<number>({ flush: (batch) => void batches.push(batch) });
    queue.push(1);
    queue.push(2);
    expect(batches).toHaveLength(0);
    expect(queue.size).toBe(2);
    expect(queue.drain()).toBe(2);
    expect(batches).toEqual([[1, 2]]);
    expect(queue.size).toBe(0);
  });

  it('drains by itself once a burst reaches the batch size', () => {
    const batches: number[][] = [];
    const queue = new WriteQueue<number>({ flush: (batch) => void batches.push(batch), maxBatch: 3 });
    queue.push(1);
    queue.push(2);
    expect(batches).toHaveLength(0);
    queue.push(3);
    expect(batches).toEqual([[1, 2, 3]]);
  });

  it('draining an empty queue is a no-op', () => {
    const flush = vi.fn();
    const queue = new WriteQueue<number>({ flush });
    expect(queue.drain()).toBe(0);
    expect(flush).not.toHaveBeenCalled();
  });

  it('a throwing flush does not retry forever or block later writes', () => {
    const seen: number[][] = [];
    const errors: unknown[] = [];
    let explode = true;
    const queue = new WriteQueue<number>({
      flush: (batch) => {
        seen.push(batch);
        if (explode) throw new Error('disk on fire');
      },
      onError: (error) => void errors.push(error),
    });

    queue.push(1);
    expect(queue.drain()).toBe(0);
    expect(errors).toHaveLength(1);
    // The bad batch is dropped rather than replayed into the same failure.
    expect(queue.size).toBe(0);
    expect(queue.stats().failed).toBe(1);

    explode = false;
    queue.push(2);
    expect(queue.drain()).toBe(1);
    expect(seen).toEqual([[1], [2]]);
    expect(queue.stats().written).toBe(1);
  });

  it('bounds memory when the database is wedged', () => {
    const dropped: number[] = [];
    const queue = new WriteQueue<number>({
      flush: () => { throw new Error('wedged'); },
      maxBatch: 1_000_000,
      maxPending: 10,
      onError: () => undefined,
      onDrop: (n) => void dropped.push(n),
    });
    for (let i = 0; i < 50; i++) queue.push(i);
    expect(queue.size).toBe(10);
    expect(queue.stats().dropped).toBe(40);
    expect(dropped.length).toBeGreaterThan(0);
  });

  it('keeps the newest entries when it has to drop', () => {
    const batches: number[][] = [];
    const queue = new WriteQueue<number>({ flush: (b) => void batches.push(b), maxBatch: 1_000_000, maxPending: 3 });
    for (let i = 0; i < 6; i++) queue.push(i);
    queue.drain();
    expect(batches).toEqual([[3, 4, 5]]);
  });

  it('never throws out of push, whatever the flush does', () => {
    const queue = new WriteQueue<number>({ flush: () => { throw new Error('nope'); }, maxBatch: 1 });
    expect(() => { for (let i = 0; i < 100; i++) queue.push(i); }).not.toThrow();
  });

  it('a nested push from inside flush is not lost', () => {
    const written: number[] = [];
    let queue: WriteQueue<number>;
    queue = new WriteQueue<number>({
      flush: (batch) => {
        written.push(...batch);
        // Re-entrancy: the guard must make this land in the *next* batch, not
        // recurse or vanish.
        if (batch.includes(1)) queue.push(99);
      },
    });
    queue.push(1);
    queue.drain();
    expect(written).toEqual([1]);
    expect(queue.size).toBe(1);
    queue.drain();
    expect(written).toEqual([1, 99]);
  });

  it('stop() writes the backlog', () => {
    const batches: number[][] = [];
    const queue = new WriteQueue<number>({ flush: (b) => void batches.push(b), intervalMs: 10_000 });
    queue.start();
    queue.push(7);
    expect(queue.stop()).toBe(1);
    expect(batches).toEqual([[7]]);
  });

  it('start() is idempotent and stop() is safe when never started', () => {
    const queue = new WriteQueue<number>({ flush: () => undefined });
    expect(() => { queue.start(); queue.start(); queue.stop(); queue.stop(); }).not.toThrow();
  });

  it('reports how long the slowest flush took', () => {
    const queue = new WriteQueue<number>({ flush: () => undefined });
    queue.push(1);
    queue.drain();
    const stats = queue.stats();
    expect(stats.maxFlushMs).toBeGreaterThanOrEqual(0);
    expect(stats.written).toBe(1);
    expect(stats.pending).toBe(0);
  });
});
