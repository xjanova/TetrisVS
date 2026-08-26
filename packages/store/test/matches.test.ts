import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReplayRecorder,
  createMatch,
  decodeReplay,
  hash,
  replayInputs,
  step,
  stepMany,
  xorshift32,
  type ActionName,
  type Inputs,
} from '@tetrisvs/core';
import {
  MatchStore,
  PlayerStore,
  STARTING_RATING,
  TetrisStore,
  closeDatabase,
  dayKey,
  expectedScore,
  openDatabase,
  ratingDelta,
  type Db,
  type MatchRecord,
} from '../src/index.js';

const DAY = 1_756_000_000_000; // fixed instant so day keys are stable

let db: Db;
let matches: MatchStore;
let players: PlayerStore;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  matches = new MatchStore(db);
  players = new PlayerStore(db);
});

afterEach(() => {
  closeDatabase(db);
});

function makeRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    roomCode: 'ABC123',
    seed: 4242,
    mode: 'online',
    startedAt: DAY,
    endedAt: DAY + 90_000,
    frames: 5400,
    winner: 0,
    reason: 'topout',
    players: [
      { playerId: null, name: 'P1', lines: 24, attack: 11 },
      { playerId: null, name: 'P2', lines: 18, attack: 7 },
    ],
    ...overrides,
  };
}

async function seedPlayers(): Promise<[number, number]> {
  const a = await players.register('alpha', 'a-good-password', 'ip');
  const b = await players.register('bravo', 'a-good-password', 'ip');
  if (!a.ok || !b.ok) throw new Error('setup failed');
  return [a.player.id, b.player.id];
}

describe('Elo', () => {
  it('equal ratings split the expectation', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it('beating a stronger player is worth more than beating a weaker one', () => {
    expect(ratingDelta(1000, 1400, 1)).toBeGreaterThan(ratingDelta(1400, 1000, 1));
  });

  it('is zero-sum between the two seats', () => {
    for (const [a, b] of [[1000, 1000], [1200, 900], [800, 1600]]) {
      expect(ratingDelta(a!, b!, 1) + ratingDelta(b!, a!, 0)).toBe(0);
    }
  });

  it('a draw between equals moves nothing', () => {
    expect(ratingDelta(1000, 1000, 0.5)).toBe(0);
  });
});

describe('dayKey', () => {
  it('is UTC and stable regardless of where the server runs', () => {
    expect(dayKey(Date.UTC(2026, 7, 27, 23, 59, 59))).toBe('2026-08-27');
    expect(dayKey(Date.UTC(2026, 7, 28, 0, 0, 0))).toBe('2026-08-28');
  });
});

describe('recording a match', () => {
  it('stores the result and reads it back', () => {
    const id = matches.record(makeRecord());
    const summary = matches.byId(id);
    expect(summary).not.toBeNull();
    expect(summary!.winner).toBe(0);
    expect(summary!.players[0].lines).toBe(24);
    expect(summary!.players[1].attack).toBe(7);
    expect(summary!.hasReplay).toBe(false);
    expect(matches.recent(10)).toHaveLength(1);
  });

  it('updates both players\' totals in the same write', async () => {
    const [a, b] = await seedPlayers();
    matches.record(makeRecord({
      winner: 0,
      players: [
        { playerId: a, name: 'alpha', lines: 30, attack: 12 },
        { playerId: b, name: 'bravo', lines: 20, attack: 5 },
      ],
    }));

    const alpha = players.byId(a)!;
    const bravo = players.byId(b)!;
    expect(alpha.matches).toBe(1);
    expect(alpha.wins).toBe(1);
    expect(alpha.lines).toBe(30);
    expect(alpha.bestAttack).toBe(12);
    expect(bravo.losses).toBe(1);
    expect(alpha.rating).toBeGreaterThan(STARTING_RATING);
    expect(bravo.rating).toBeLessThan(STARTING_RATING);
    expect(alpha.rating + bravo.rating).toBe(2 * STARTING_RATING);
  });

  it('leaves rating alone when either seat is a guest', async () => {
    const [a] = await seedPlayers();
    matches.record(makeRecord({
      winner: 0,
      players: [
        { playerId: a, name: 'alpha', lines: 10, attack: 3 },
        { playerId: null, name: 'guest', lines: 4, attack: 1 },
      ],
    }));
    const alpha = players.byId(a)!;
    expect(alpha.wins).toBe(1);
    expect(alpha.rating).toBe(STARTING_RATING);
    expect(matches.byId(1)!.players[0].ratingDelta).toBe(0);
  });

  it('a draw counts for both and moves neither', async () => {
    const [a, b] = await seedPlayers();
    matches.record(makeRecord({
      winner: null,
      players: [
        { playerId: a, name: 'alpha', lines: 1, attack: 1 },
        { playerId: b, name: 'bravo', lines: 1, attack: 1 },
      ],
    }));
    expect(players.byId(a)!.draws).toBe(1);
    expect(players.byId(b)!.draws).toBe(1);
    expect(players.byId(a)!.rating).toBe(STARTING_RATING);
  });

  it('keeps the anonymous daily counters in step with the matches', () => {
    matches.record(makeRecord({ frames: 1000, reason: 'topout' }));
    matches.record(makeRecord({ frames: 4000, reason: 'forfeit', winner: null }));
    matches.record(makeRecord({ frames: 2000, mode: 'local' }));

    const [today] = matches.days(1);
    expect(today!.day).toBe(dayKey(DAY + 90_000));
    expect(today!.matches).toBe(3);
    expect(today!.onlineMatches).toBe(2);
    expect(today!.forfeits).toBe(1);
    expect(today!.draws).toBe(1);
    expect(today!.longestFrames).toBe(4000);
    expect(matches.totals().matches).toBe(3);
  });

  it('carries no personal data into the daily table', () => {
    matches.record(makeRecord());
    const columns = (db.prepare('PRAGMA table_info(stats_daily)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const forbidden of ['player_id', 'username', 'p0_id', 'p1_id', 'source', 'ip']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('ranks the leaderboard by rating and skips players who never played', async () => {
    const [a, b] = await seedPlayers();
    await players.register('charlie', 'a-good-password', 'ip');
    matches.record(makeRecord({
      winner: 1,
      players: [
        { playerId: a, name: 'alpha', lines: 5, attack: 2 },
        { playerId: b, name: 'bravo', lines: 9, attack: 6 },
      ],
    }));
    const board = matches.leaderboard(10);
    expect(board).toHaveLength(2);
    expect(board[0]!.username).toBe('bravo');
    expect(board[0]!.rank).toBe(1);
    expect(board[1]!.username).toBe('alpha');
  });

  it('clamps a hostile limit instead of trying to serve it', () => {
    for (let i = 0; i < 5; i++) matches.record(makeRecord());
    expect(() => matches.recent(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => matches.recent(-1)).not.toThrow();
    expect(() => matches.recent(Number.NaN)).not.toThrow();
    expect(matches.recent(-1)).toHaveLength(1);
  });

  it('rolls the whole result back if any part of it fails', async () => {
    const [a] = await seedPlayers();
    const before = players.byId(a)!;
    // A foreign key to a player that does not exist must abort the transaction.
    expect(() => matches.record(makeRecord({
      players: [
        { playerId: a, name: 'alpha', lines: 5, attack: 2 },
        { playerId: 99_999, name: 'ghost', lines: 1, attack: 0 },
      ],
    }))).toThrow();
    expect(matches.recent(10)).toHaveLength(0);
    expect(players.byId(a)!.matches).toBe(before.matches);
    expect(players.byId(a)!.rating).toBe(before.rating);
  });
});

describe('replays survive the round trip through the database', () => {
  const ACTIONS: ActionName[] = ['left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold'];

  function scripted(seed: number, frame: number): Inputs {
    let s = seed >>> 0 || 1;
    const mk = () => {
      s = xorshift32(s);
      const pressed: ActionName[] = [];
      const held: ActionName[] = [];
      if (s % 5 === 0) pressed.push(ACTIONS[s % ACTIONS.length]!);
      s = xorshift32(s);
      if (s % 3 === 0) held.push(s % 2 === 0 ? 'left' : 'right');
      return { frame, pressed, held };
    };
    return [mk(), mk()];
  }

  it('a stored replay reproduces the original match hash', () => {
    const seed = 987654;
    const recorder = new ReplayRecorder();
    let live = createMatch(seed);
    for (let tick = 0; tick < 900; tick++) {
      const inputs = scripted(live.frame + 1, live.frame);
      recorder.record(inputs);
      live = step(live, inputs).state;
      if (live.status === 'finished') break;
    }

    const id = matches.record(makeRecord({
      seed,
      frames: live.frame,
      winner: live.winner,
      replay: { version: 1, ticks: recorder.ticks, bytes: recorder.encode() },
    }));

    const stored = matches.replay(id);
    expect(stored).not.toBeNull();
    expect(stored!.ticks).toBe(recorder.ticks);
    expect(matches.byId(id)!.hasReplay).toBe(true);

    const rebuilt = stepMany(createMatch(seed), replayInputs(decodeReplay(stored!.bytes))).state;
    expect(hash(rebuilt)).toBe(hash(live));
    expect(rebuilt.players[0].board).toEqual(live.players[0].board);
  });

  it('deleting the match takes the replay with it', () => {
    const id = matches.record(makeRecord({ replay: { version: 1, ticks: 3, bytes: new Uint8Array([84, 82, 1, 3, 0, 3]) } }));
    expect(matches.replay(id)).not.toBeNull();
    db.prepare('DELETE FROM matches WHERE id = ?').run(id);
    expect(matches.replay(id)).toBeNull();
  });
});

describe('TetrisStore', () => {
  it('queues match writes instead of doing them inline, then flushes', () => {
    const store = new TetrisStore({ file: ':memory:' });
    try {
      store.recordMatch(makeRecord());
      store.recordMatch(makeRecord());
      // Nothing has touched the database yet — that is the whole point.
      expect(store.matches.recent(10)).toHaveLength(0);
      expect(store.queueStats().pending).toBe(2);

      expect(store.flush()).toBe(2);
      expect(store.matches.recent(10)).toHaveLength(2);
      expect(store.queueStats().written).toBe(2);
    } finally {
      store.close();
    }
  });

  it('close() flushes what is still queued rather than losing it', () => {
    const store = new TetrisStore({ file: ':memory:' });
    store.recordMatch(makeRecord());
    const written = store.queueStats();
    expect(written.pending).toBe(1);
    store.close();
    expect(store.queueStats().written).toBe(1);
    // Closing twice must not throw.
    expect(() => store.close()).not.toThrow();
  });
});
