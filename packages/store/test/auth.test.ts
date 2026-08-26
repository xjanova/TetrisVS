import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN,
  PlayerStore,
  USERNAME_MAX,
  closeDatabase,
  hashPassword,
  needsRehash,
  normalizeUsername,
  openDatabase,
  parseParams,
  verifyPassword,
  type Db,
} from '../src/index.js';

let db: Db;
let players: PlayerStore;

/**
 * scrypt is deliberately slow, so these tests use the weakest parameters the
 * validator accepts. The code path is identical; only the work factor differs.
 */
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  players = new PlayerStore(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe('username rules', () => {
  it('accepts what the UI allows and folds case', () => {
    expect(normalizeUsername('Neo')).toEqual({ username: 'Neo', fold: 'neo' });
    expect(normalizeUsername('  spaced  ')).toEqual({ username: 'spaced', fold: 'spaced' });
    expect(normalizeUsername('a_b-c9')).toEqual({ username: 'a_b-c9', fold: 'a_b-c9' });
  });

  it('rejects everything else without throwing', () => {
    const bad = [
      null, undefined, 42, {}, [], '', 'ab', 'x'.repeat(USERNAME_MAX + 1),
      'has space', 'drop;table', "o'brien", '<script>', 'emoji😀', 'semi;colon', '../../etc',
    ];
    for (const value of bad) {
      expect(() => normalizeUsername(value)).not.toThrow();
      expect(normalizeUsername(value)).toBeNull();
    }
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects near misses', async () => {
    const stored = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterY', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash — two identical passwords do not collide', async () => {
    const a = await hashPassword('same password', FAST);
    const b = await hashPassword('same password', FAST);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(false);
  });

  it('never stores the password itself', async () => {
    const secret = 'super-secret-passphrase';
    const stored = await hashPassword(secret, FAST);
    expect(stored.hash.toString('utf8')).not.toContain(secret);
    expect(stored.salt.toString('utf8')).not.toContain(secret);
    expect(stored.params).not.toContain(secret);
  });

  it('refuses parameters that would let a crafted row exhaust the box', () => {
    expect(parseParams('scrypt$N=1048576,r=32,p=1,len=32')).toBeNull(); // 4 GB
    expect(parseParams('scrypt$N=1000,r=8,p=1,len=32')).toBeNull(); // not a power of two
    expect(parseParams('scrypt$N=1024,r=8,p=1,len=8')).toBeNull(); // key too short
    expect(parseParams('nonsense')).toBeNull();
    expect(parseParams('scrypt$N=1024,r=8,p=1,len=32')).toEqual(FAST);
  });

  it('treats a corrupt stored row as a failed login, not a crash', async () => {
    const stored = await hashPassword('whatever', FAST);
    expect(await verifyPassword('whatever', { ...stored, params: 'garbage' })).toBe(false);
    expect(await verifyPassword('whatever', { ...stored, hash: Buffer.alloc(1) })).toBe(false);
  });

  it('flags hashes made with weaker settings for upgrade', async () => {
    const weak = await hashPassword('pw', FAST);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(weak, FAST)).toBe(false);
  });
});

describe('register', () => {
  it('creates an account and hands back a session', async () => {
    const result = await players.register('Neo', 'a-good-password', '10.0.0.1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.player.username).toBe('Neo');
    expect(result.player.rating).toBe(1000);
    expect(result.token.length).toBeGreaterThan(20);
    expect(players.resolveSession(result.token)?.id).toBe(result.player.id);
  });

  it('is case-insensitive about names already taken', async () => {
    await players.register('Neo', 'a-good-password', '10.0.0.1');
    const dup = await players.register('NEO', 'another-password', '10.0.0.2');
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.reason).toBe('username-taken');
  });

  it('rejects weak or malformed input with a reason, never an exception', async () => {
    const shortPw = await players.register('valid', 'x'.repeat(PASSWORD_MIN - 1), 'ip');
    expect(shortPw.ok).toBe(false);
    const badName = await players.register('a', 'a-good-password', 'ip');
    expect(badName.ok).toBe(false);
    for (const value of [null, undefined, 42, {}, []]) {
      await expect(players.register(value, value, 'ip')).resolves.toMatchObject({ ok: false });
    }
  });

  it('rate-limits mass account creation from one source', async () => {
    for (let i = 0; i < 5; i++) {
      const made = await players.register(`user${i}`, 'a-good-password', '1.2.3.4');
      expect(made.ok).toBe(true);
    }
    const blocked = await players.register('user5', 'a-good-password', '1.2.3.4');
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('rate-limited');
    // A different source is unaffected.
    await expect(players.register('elsewhere', 'a-good-password', '5.6.7.8')).resolves.toMatchObject({ ok: true });
  });
});

describe('login', () => {
  beforeEach(async () => {
    await players.register('Neo', 'the-real-password', '10.0.0.1');
  });

  it('accepts the right password, any casing of the name', async () => {
    await expect(players.login('neo', 'the-real-password', 'ip')).resolves.toMatchObject({ ok: true });
    await expect(players.login('NEO', 'the-real-password', 'ip')).resolves.toMatchObject({ ok: true });
  });

  it('gives the same message whether the user exists or not', async () => {
    const wrongPassword = await players.login('Neo', 'not-the-password', 'ip');
    const noSuchUser = await players.login('Trinity', 'not-the-password', 'ip');
    expect(wrongPassword.ok).toBe(false);
    expect(noSuchUser.ok).toBe(false);
    if (wrongPassword.ok || noSuchUser.ok) return;
    // Identical reason and wording: the response must not confirm the account.
    expect(noSuchUser.reason).toBe(wrongPassword.reason);
    expect(noSuchUser.message).toBe(wrongPassword.message);
  });

  it('locks an account out after repeated failures, then still blocks the right password', async () => {
    for (let i = 0; i < 10; i++) {
      await players.login('Neo', `guess-${i}`, `attacker-${i}`);
    }
    const blocked = await players.login('Neo', 'the-real-password', 'attacker-final');
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('rate-limited');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('locks a single source out even when it sprays different names', async () => {
    for (let i = 0; i < 30; i++) {
      await players.login(`victim${i}`, 'guess', 'one-bad-ip');
    }
    const blocked = await players.login('Neo', 'the-real-password', 'one-bad-ip');
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('rate-limited');
  });

  it('lets the lockout expire', async () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 10; i++) await players.login('Neo', 'guess', 'ip', t0);
    await expect(players.login('Neo', 'the-real-password', 'ip', t0)).resolves.toMatchObject({ ok: false });
    const later = t0 + 16 * 60 * 1000;
    await expect(players.login('Neo', 'the-real-password', 'ip', later)).resolves.toMatchObject({ ok: true });
  });

  it('does not throw on hostile payloads', async () => {
    for (const value of [null, undefined, 0, {}, [], 'x'.repeat(100_000)]) {
      await expect(players.login(value, value, 'ip')).resolves.toMatchObject({ ok: false });
    }
  });
});

describe('sessions', () => {
  it('stores only a digest — the raw token is not recoverable from the database', async () => {
    const result = await players.register('Neo', 'a-good-password', 'ip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = db.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: Buffer }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.toString('utf8')).not.toContain(result.token);
    expect(rows[0]!.token_hash.toString('base64url')).not.toBe(result.token);
    // Dumping every text column must not reveal the token anywhere.
    const dump = JSON.stringify(db.prepare('SELECT * FROM players').all());
    expect(dump).not.toContain(result.token);
  });

  it('rejects unknown, malformed, and expired tokens', async () => {
    const result = await players.register('Neo', 'a-good-password', 'ip');
    if (!result.ok) return;
    expect(players.resolveSession('nope-not-a-real-token')).toBeNull();
    expect(players.resolveSession('')).toBeNull();
    expect(players.resolveSession(null)).toBeNull();
    expect(players.resolveSession(12345)).toBeNull();
    expect(players.resolveSession(result.token, result.expiresAt + 1)).toBeNull();
    // ...and an expired token is cleaned up rather than left to accumulate.
    expect(db.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('logout invalidates one session, logoutAll invalidates the rest', async () => {
    const first = await players.register('Neo', 'a-good-password', 'ip');
    if (!first.ok) return;
    const second = await players.login('Neo', 'a-good-password', 'ip');
    if (!second.ok) return;

    expect(players.logout(first.token)).toBe(true);
    expect(players.resolveSession(first.token)).toBeNull();
    expect(players.resolveSession(second.token)?.id).toBe(first.player.id);

    players.logoutAll(first.player.id);
    expect(players.resolveSession(second.token)).toBeNull();
  });

  it('prune clears expired sessions and stale attempts', async () => {
    const t0 = 1_000_000_000_000;
    const made = await players.register('Neo', 'a-good-password', 'ip', t0);
    if (!made.ok) return;
    const swept = players.prune(made.expiresAt + 1);
    expect(swept.sessions).toBe(1);
    expect(players.resolveSession(made.token)).toBeNull();
  });
});

describe('prototype pollution', () => {
  it('a crafted JSON body cannot add fields to every object', async () => {
    const body = JSON.parse('{"__proto__":{"admin":true},"username":"poller","password":"a-good-password"}');
    const result = await players.register(body.username, body.password, 'ip');
    expect(result.ok).toBe(true);
    // Nothing the payload carried may have reached Object.prototype...
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    // ...and the created player has exactly the fields we define.
    if (!result.ok) return;
    expect(Object.keys(result.player).sort()).toEqual([
      'attack', 'bestAttack', 'createdAt', 'draws', 'id', 'lastSeenAt',
      'lines', 'losses', 'matches', 'rating', 'username', 'wins',
    ]);
    expect((result.player as Record<string, unknown>).admin).toBeUndefined();
  });

  it('ignores extra fields rather than storing them', async () => {
    const result = await players.register('extra', 'a-good-password', 'ip');
    expect(result.ok).toBe(true);
    const columns = (db.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).not.toContain('admin');
    expect(columns).not.toContain('__proto__');
  });
});

describe('SQL injection', () => {
  it('cannot reach the SQL text through a username', async () => {
    const payloads = [
      "'; DROP TABLE players; --",
      "' OR '1'='1",
      'admin"--',
      "\\'; DELETE FROM sessions WHERE ''='",
    ];
    for (const payload of payloads) {
      // The whitelist rejects them before SQL is even involved...
      expect(normalizeUsername(payload)).toBeNull();
      await expect(players.register(payload, 'a-good-password', 'ip')).resolves.toMatchObject({ ok: false });
      await expect(players.login(payload, 'a-good-password', 'ip')).resolves.toMatchObject({ ok: false });
    }
    // ...and the tables are still there.
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('players','sessions')").get()).toEqual({ n: 2 });
  });

  it('bound parameters survive a hostile source string', async () => {
    const nasty = "'; DROP TABLE login_attempts; --";
    await players.login('Neo', 'pw', nasty);
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'login_attempts'").get()).toEqual({ n: 1 });
  });
});
