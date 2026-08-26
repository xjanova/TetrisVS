/**
 * Match results, replays, leaderboard, and the anonymous daily counters.
 *
 * `record()` writes the match row, the replay blob, both players' running
 * totals, and the day's aggregate **in one transaction**. Anything less and a
 * crash mid-write leaves a leaderboard that disagrees with the match list, with
 * no way to tell which is right.
 */

import type { Database as Db, Statement } from 'better-sqlite3';
import type { PlayerId } from '@tetrisvs/core';

export type EndReason = 'topout' | 'forfeit';
export type MatchMode = 'local' | 'online';

/** How much one result can move a rating. Chess uses 10-40; 24 settles quickly. */
export const ELO_K = 24;
export const STARTING_RATING = 1000;

export interface MatchSide {
  /** `null` for a guest — the match is still recorded, it just earns nobody a rating. */
  playerId: number | null;
  name: string;
  lines: number;
  attack: number;
}

export interface MatchRecord {
  roomCode: string | null;
  seed: number;
  mode: MatchMode;
  startedAt: number;
  endedAt: number;
  frames: number;
  winner: PlayerId | null;
  reason: EndReason;
  players: [MatchSide, MatchSide];
  /** Encoded input log from `ReplayRecorder`. Omit and no replay is stored. */
  replay?: { version: number; ticks: number; bytes: Uint8Array };
}

export interface MatchSummary {
  id: number;
  roomCode: string | null;
  seed: number;
  mode: MatchMode;
  startedAt: number;
  endedAt: number;
  frames: number;
  winner: PlayerId | null;
  reason: EndReason;
  players: [MatchSide & { ratingDelta: number }, MatchSide & { ratingDelta: number }];
  hasReplay: boolean;
}

export interface LeaderboardRow {
  rank: number;
  id: number;
  username: string;
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  lines: number;
  attack: number;
  bestAttack: number;
}

export interface DailyStats {
  day: string;
  matches: number;
  onlineMatches: number;
  forfeits: number;
  draws: number;
  frames: number;
  lines: number;
  attack: number;
  longestFrames: number;
}

/**
 * Standard Elo expectation. Pure, so the rating maths is testable without a
 * database.
 */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** Rating change for `rating` scoring `score` (1 win, 0.5 draw, 0 loss). */
export function ratingDelta(rating: number, opponent: number, score: number, k = ELO_K): number {
  return Math.round(k * (score - expectedScore(rating, opponent)));
}

/** UTC day key. Explicitly not locale-dependent — the server may move timezone. */
export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

interface MatchRow {
  id: number;
  room_code: string | null;
  seed: number;
  mode: MatchMode;
  started_at: number;
  ended_at: number;
  frames: number;
  winner: number | null;
  reason: EndReason;
  p0_id: number | null;
  p1_id: number | null;
  p0_name: string;
  p1_name: string;
  p0_lines: number;
  p1_lines: number;
  p0_attack: number;
  p1_attack: number;
  p0_rating_delta: number;
  p1_rating_delta: number;
  has_replay: number;
}

function toSummary(row: MatchRow): MatchSummary {
  return {
    id: row.id,
    roomCode: row.room_code,
    seed: row.seed,
    mode: row.mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    frames: row.frames,
    winner: row.winner === null ? null : (row.winner as PlayerId),
    reason: row.reason,
    players: [
      { playerId: row.p0_id, name: row.p0_name, lines: row.p0_lines, attack: row.p0_attack, ratingDelta: row.p0_rating_delta },
      { playerId: row.p1_id, name: row.p1_name, lines: row.p1_lines, attack: row.p1_attack, ratingDelta: row.p1_rating_delta },
    ],
    hasReplay: row.has_replay > 0,
  };
}

interface LeaderboardRowRaw {
  id: number;
  username: string;
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  lines: number;
  attack: number;
  best_attack: number;
}

interface DailyRow {
  day: string;
  matches: number;
  online_matches: number;
  forfeits: number;
  draws: number;
  frames: number;
  lines: number;
  attack: number;
  longest_frames: number;
}

const SUMMARY_COLUMNS = `
  m.*, (SELECT COUNT(*) FROM replays r WHERE r.match_id = m.id) AS has_replay
`;

export class MatchStore {
  private readonly insertMatch: Statement;
  private readonly insertReplay: Statement;
  private readonly bumpPlayer: Statement;
  private readonly applyRating: Statement;
  private readonly ratingOf: Statement;
  private readonly upsertDay: Statement;

  private readonly recentStmt: Statement;
  private readonly forPlayerStmt: Statement;
  private readonly byIdStmt: Statement;
  private readonly replayStmt: Statement;
  private readonly leaderboardStmt: Statement;
  private readonly daysStmt: Statement;
  private readonly totalsStmt: Statement;

  private readonly writeAll: (record: MatchRecord) => number;

  constructor(private readonly db: Db) {
    this.insertMatch = db.prepare(`
      INSERT INTO matches (
        room_code, seed, mode, started_at, ended_at, frames, winner, reason,
        p0_id, p1_id, p0_name, p1_name, p0_lines, p1_lines, p0_attack, p1_attack,
        p0_rating_delta, p1_rating_delta
      ) VALUES (
        @roomCode, @seed, @mode, @startedAt, @endedAt, @frames, @winner, @reason,
        @p0Id, @p1Id, @p0Name, @p1Name, @p0Lines, @p1Lines, @p0Attack, @p1Attack,
        @p0Delta, @p1Delta
      )
    `);
    this.insertReplay = db.prepare(`
      INSERT INTO replays (match_id, version, ticks, bytes) VALUES (?, ?, ?, ?)
    `);
    this.bumpPlayer = db.prepare(`
      UPDATE players SET
        matches     = matches + 1,
        wins        = wins   + @win,
        losses      = losses + @loss,
        draws       = draws  + @draw,
        lines       = lines  + @lines,
        attack      = attack + @attack,
        best_attack = MAX(best_attack, @attack),
        last_seen_at = @now
      WHERE id = @id
    `);
    this.applyRating = db.prepare('UPDATE players SET rating = MAX(100, rating + ?) WHERE id = ?');
    this.ratingOf = db.prepare('SELECT rating FROM players WHERE id = ?');
    this.upsertDay = db.prepare(`
      INSERT INTO stats_daily (day, matches, online_matches, forfeits, draws, frames, lines, attack, longest_frames)
      VALUES (@day, 1, @online, @forfeit, @draw, @frames, @lines, @attack, @frames)
      ON CONFLICT(day) DO UPDATE SET
        matches        = matches + 1,
        online_matches = online_matches + @online,
        forfeits       = forfeits + @forfeit,
        draws          = draws + @draw,
        frames         = frames + @frames,
        lines          = lines + @lines,
        attack         = attack + @attack,
        longest_frames = MAX(longest_frames, @frames)
    `);

    this.recentStmt = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM matches m ORDER BY m.ended_at DESC, m.id DESC LIMIT ?`);
    this.forPlayerStmt = db.prepare(`
      SELECT ${SUMMARY_COLUMNS} FROM matches m
      WHERE m.p0_id = @id OR m.p1_id = @id
      ORDER BY m.ended_at DESC, m.id DESC LIMIT @limit
    `);
    this.byIdStmt = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM matches m WHERE m.id = ?`);
    this.replayStmt = db.prepare('SELECT version, ticks, bytes FROM replays WHERE match_id = ?');
    this.leaderboardStmt = db.prepare(`
      SELECT id, username, rating, matches, wins, losses, draws, lines, attack, best_attack
      FROM players WHERE matches > 0
      ORDER BY rating DESC, wins DESC, id ASC LIMIT ?
    `);
    this.daysStmt = db.prepare('SELECT * FROM stats_daily ORDER BY day DESC LIMIT ?');
    this.totalsStmt = db.prepare(`
      SELECT
        COALESCE(SUM(matches), 0)        AS matches,
        COALESCE(SUM(online_matches), 0) AS onlineMatches,
        COALESCE(SUM(frames), 0)         AS frames,
        COALESCE(SUM(lines), 0)          AS lines,
        COALESCE(SUM(attack), 0)         AS attack
      FROM stats_daily
    `);

    // One transaction for the whole result. better-sqlite3 runs the callback
    // synchronously inside BEGIN/COMMIT and rolls back if it throws.
    this.writeAll = db.transaction((record: MatchRecord): number => {
      const [p0, p1] = record.players;
      const deltas = this.computeDeltas(record);

      const result = this.insertMatch.run({
        roomCode: record.roomCode,
        seed: record.seed | 0,
        mode: record.mode,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        frames: record.frames,
        winner: record.winner,
        reason: record.reason,
        p0Id: p0.playerId,
        p1Id: p1.playerId,
        p0Name: p0.name,
        p1Name: p1.name,
        p0Lines: p0.lines,
        p1Lines: p1.lines,
        p0Attack: p0.attack,
        p1Attack: p1.attack,
        p0Delta: deltas[0],
        p1Delta: deltas[1],
      });
      const matchId = Number(result.lastInsertRowid);

      if (record.replay) {
        this.insertReplay.run(matchId, record.replay.version, record.replay.ticks, Buffer.from(record.replay.bytes));
      }

      for (const seat of [0, 1] as const) {
        const side = record.players[seat];
        if (side.playerId === null) continue;
        const won = record.winner === seat;
        const drew = record.winner === null;
        this.bumpPlayer.run({
          id: side.playerId,
          win: won ? 1 : 0,
          loss: !won && !drew ? 1 : 0,
          draw: drew ? 1 : 0,
          lines: side.lines,
          attack: side.attack,
          now: record.endedAt,
        });
        if (deltas[seat] !== 0) this.applyRating.run(deltas[seat], side.playerId);
      }

      this.upsertDay.run({
        day: dayKey(record.endedAt),
        online: record.mode === 'online' ? 1 : 0,
        forfeit: record.reason === 'forfeit' ? 1 : 0,
        draw: record.winner === null ? 1 : 0,
        frames: record.frames,
        lines: p0.lines + p1.lines,
        attack: p0.attack + p1.attack,
      });

      return matchId;
    });
  }

  /** Rating is only at stake when both seats are registered accounts. */
  private computeDeltas(record: MatchRecord): [number, number] {
    const [p0, p1] = record.players;
    if (p0.playerId === null || p1.playerId === null) return [0, 0];
    const r0 = (this.ratingOf.get(p0.playerId) as { rating: number } | undefined)?.rating ?? STARTING_RATING;
    const r1 = (this.ratingOf.get(p1.playerId) as { rating: number } | undefined)?.rating ?? STARTING_RATING;
    const s0 = record.winner === null ? 0.5 : record.winner === 0 ? 1 : 0;
    return [ratingDelta(r0, r1, s0), ratingDelta(r1, r0, 1 - s0)];
  }

  /** Persist a finished match. Returns its id. */
  record(record: MatchRecord): number {
    return this.writeAll(record);
  }

  /** Persist a batch atomically — used by the write queue. */
  recordMany(records: readonly MatchRecord[]): number[] {
    const all = this.db.transaction((batch: readonly MatchRecord[]) => batch.map((item) => this.writeAll(item)));
    return all(records);
  }

  // -------------------------------------------------------------- reads

  recent(limit = 20): MatchSummary[] {
    return (this.recentStmt.all(clampLimit(limit)) as MatchRow[]).map(toSummary);
  }

  forPlayer(playerId: number, limit = 20): MatchSummary[] {
    return (this.forPlayerStmt.all({ id: playerId, limit: clampLimit(limit) }) as MatchRow[]).map(toSummary);
  }

  byId(id: number): MatchSummary | null {
    const row = this.byIdStmt.get(id) as MatchRow | undefined;
    return row ? toSummary(row) : null;
  }

  replay(matchId: number): { version: number; ticks: number; bytes: Uint8Array } | null {
    const row = this.replayStmt.get(matchId) as { version: number; ticks: number; bytes: Buffer } | undefined;
    return row ? { version: row.version, ticks: row.ticks, bytes: new Uint8Array(row.bytes) } : null;
  }

  leaderboard(limit = 50): LeaderboardRow[] {
    const rows = this.leaderboardStmt.all(clampLimit(limit)) as LeaderboardRowRaw[];
    return rows.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      username: row.username,
      rating: row.rating,
      matches: row.matches,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      lines: row.lines,
      attack: row.attack,
      bestAttack: row.best_attack,
    }));
  }

  days(limit = 30): DailyStats[] {
    const rows = this.daysStmt.all(clampLimit(limit)) as DailyRow[];
    return rows.map((row) => ({
      day: row.day,
      matches: row.matches,
      onlineMatches: row.online_matches,
      forfeits: row.forfeits,
      draws: row.draws,
      frames: row.frames,
      lines: row.lines,
      attack: row.attack,
      longestFrames: row.longest_frames,
    }));
  }

  totals(): { matches: number; onlineMatches: number; frames: number; lines: number; attack: number } {
    return this.totalsStmt.get() as { matches: number; onlineMatches: number; frames: number; lines: number; attack: number };
  }
}

/** A client-supplied `limit` is a request, not an instruction. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}
