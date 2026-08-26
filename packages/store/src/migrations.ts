/**
 * Schema, as an append-only list.
 *
 * Never edit a migration that has shipped — add another one. The array index is
 * the schema version, so reordering or removing an entry silently reinterprets
 * every database already on disk.
 *
 * Every column a query filters or sorts on has an index. On SQLite a missing
 * index does not error, it just turns a leaderboard read into a full scan that
 * blocks the event loop this process also runs the simulation on.
 */

import type { Database as Db } from 'better-sqlite3';

export type Migration = (db: Db) => void;

export const MIGRATIONS: readonly Migration[] = [
  // ---------------------------------------------------------------- 0 -> 1
  (db) => {
    db.exec(`
      -- Registered players. Guests are simply a NULL player id on a match.
      CREATE TABLE players (
        id              INTEGER PRIMARY KEY,
        -- as typed, for display
        username        TEXT    NOT NULL,
        -- case-folded, for lookup and uniqueness: 'Neo' and 'neo' are one player
        username_fold   TEXT    NOT NULL UNIQUE,
        password_hash   BLOB    NOT NULL,
        password_salt   BLOB    NOT NULL,
        -- the KDF settings this hash was made with, so they can be raised later
        -- without invalidating everyone's password
        password_params TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        last_seen_at    INTEGER,
        -- Denormalised totals, updated in the same transaction as the match they
        -- come from. A leaderboard must not have to scan the match table.
        matches         INTEGER NOT NULL DEFAULT 0,
        wins            INTEGER NOT NULL DEFAULT 0,
        losses          INTEGER NOT NULL DEFAULT 0,
        draws           INTEGER NOT NULL DEFAULT 0,
        lines           INTEGER NOT NULL DEFAULT 0,
        attack          INTEGER NOT NULL DEFAULT 0,
        best_attack     INTEGER NOT NULL DEFAULT 0,
        rating          INTEGER NOT NULL DEFAULT 1000
      ) STRICT;

      CREATE INDEX players_rating    ON players(rating DESC, wins DESC, id);
      CREATE INDEX players_created   ON players(created_at DESC);

      -- Login sessions. The raw bearer token is NEVER stored: a database leak
      -- must not hand the attacker working sessions.
      CREATE TABLE sessions (
        token_hash   BLOB    PRIMARY KEY,
        player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX sessions_player  ON sessions(player_id);
      CREATE INDEX sessions_expires ON sessions(expires_at);

      -- Failed and successful sign-ins, for rate limiting. Pruned on a timer.
      CREATE TABLE login_attempts (
        id            INTEGER PRIMARY KEY,
        username_fold TEXT,
        source        TEXT,
        at            INTEGER NOT NULL,
        ok            INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX login_attempts_user   ON login_attempts(username_fold, at);
      CREATE INDEX login_attempts_source ON login_attempts(source, at);
      CREATE INDEX login_attempts_at     ON login_attempts(at);

      -- One row per finished match.
      CREATE TABLE matches (
        id          INTEGER PRIMARY KEY,
        room_code   TEXT,
        seed        INTEGER NOT NULL,
        mode        TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER NOT NULL,
        frames      INTEGER NOT NULL,
        -- 0, 1, or NULL for a draw
        winner      INTEGER,
        reason      TEXT    NOT NULL,
        p0_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
        p1_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
        p0_name     TEXT    NOT NULL,
        p1_name     TEXT    NOT NULL,
        p0_lines    INTEGER NOT NULL,
        p1_lines    INTEGER NOT NULL,
        p0_attack   INTEGER NOT NULL,
        p1_attack   INTEGER NOT NULL,
        p0_rating_delta INTEGER NOT NULL DEFAULT 0,
        p1_rating_delta INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX matches_ended ON matches(ended_at DESC);
      CREATE INDEX matches_p0    ON matches(p0_id, ended_at DESC);
      CREATE INDEX matches_p1    ON matches(p1_id, ended_at DESC);

      -- Seed plus the input log. The simulation is deterministic, so this is a
      -- complete recording of the match in a few kB — there is no frame data.
      CREATE TABLE replays (
        match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
        version  INTEGER NOT NULL,
        ticks    INTEGER NOT NULL,
        bytes    BLOB    NOT NULL
      ) STRICT;

      -- Aggregate counters with nobody attached: safe to expose publicly and
      -- safe to keep after a player deletes their account.
      CREATE TABLE stats_daily (
        day            TEXT    PRIMARY KEY,
        matches        INTEGER NOT NULL DEFAULT 0,
        online_matches INTEGER NOT NULL DEFAULT 0,
        forfeits       INTEGER NOT NULL DEFAULT 0,
        draws          INTEGER NOT NULL DEFAULT 0,
        frames         INTEGER NOT NULL DEFAULT 0,
        lines          INTEGER NOT NULL DEFAULT 0,
        attack         INTEGER NOT NULL DEFAULT 0,
        longest_frames INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
  },
];
