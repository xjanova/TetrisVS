import { describe, expect, it } from 'vitest';
import { MatchmakingQueue } from '../src/matchmaker.js';

describe('MatchmakingQueue', () => {
  it('pairs the oldest compatible waiter first', () => {
    const queue = new MatchmakingQueue();
    expect(queue.enqueue('oldest', 'v1')).toBeNull();
    expect(queue.enqueue('other-pool', 'v2')).toBeNull();
    expect(queue.enqueue('newcomer', 'v1')).toEqual([
      { socketId: 'oldest', pool: 'v1' },
      { socketId: 'newcomer', pool: 'v1' },
    ]);
    expect(queue.snapshot()).toEqual([{ socketId: 'other-pool', pool: 'v2' }]);
  });

  it('does not queue or match the same socket twice', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('one');
    expect(queue.enqueue('one')).toBeNull();
    expect(queue.size).toBe(1);
    expect(queue.enqueue('two')?.map((ticket) => ticket.socketId)).toEqual(['one', 'two']);
    expect(queue.size).toBe(0);
  });

  it('removes cancelled and disconnected waiters idempotently', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('cancelled');
    expect(queue.remove('cancelled')).toBe(true);
    expect(queue.remove('cancelled')).toBe(false);
    expect(queue.enqueue('replacement')).toBeNull();
    expect(queue.enqueue('opponent')?.map((ticket) => ticket.socketId)).toEqual(['replacement', 'opponent']);
  });

  it('never pairs incompatible pools', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('v1-a', 'v1');
    queue.enqueue('v2-a', 'v2');
    expect(queue.enqueue('v2-b', 'v2')?.map((ticket) => ticket.socketId)).toEqual(['v2-a', 'v2-b']);
    expect(queue.has('v1-a')).toBe(true);
  });
});
