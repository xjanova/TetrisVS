import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdminStore,
  MatchStore,
  PlayerStore,
  closeDatabase,
  openDatabase,
  schemaVersion,
  type AdminPlayer,
  type Db,
} from '../src/index.js';

let db: Db;
let players: PlayerStore;
let admin: AdminStore;

/** Weakest parameters the validator accepts — the code path is identical. */
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  players = new PlayerStore(db, { params: FAST });
  admin = new AdminStore(db);
});

afterEach(() => {
  closeDatabase(db);
});

async function make(name: string): Promise<number> {
  const result = await players.register(name, 'a-good-password', 'ip');
  if (!result.ok) throw new Error(`could not create ${name}`);
  return result.player.id;
}

function asOperator(id: number): AdminPlayer {
  const player = admin.player(id);
  if (!player) throw new Error('missing');
  return player;
}

describe('schema', () => {
  it('migrates all the way up on a fresh database', () => {
    expect(schemaVersion(db)).toBe(2);
  });

  it('is idempotent — reopening the same file applies nothing new', () => {
    const before = schemaVersion(db);
    const again = new AdminStore(db);
    expect(again.adminCount).toBe(0);
    expect(schemaVersion(db)).toBe(before);
  });
});

describe('first-owner bootstrap', () => {
  it('starts out needing setup', async () => {
    await make('nobody');
    expect(admin.needsSetup()).toBe(true);
  });

  it('promotes the first claimant to owner', async () => {
    const id = await make('boss');
    const result = admin.claimFirstOwner(id, 'boss');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.player.role).toBe('owner');
    expect(admin.needsSetup()).toBe(false);
  });

  it('refuses a second claim — the race is closed inside the transaction', async () => {
    const first = await make('boss');
    const second = await make('usurper');
    expect(admin.claimFirstOwner(first, 'boss').ok).toBe(true);

    const later = admin.claimFirstOwner(second, 'usurper');
    expect(later.ok).toBe(false);
    if (later.ok) return;
    expect(later.reason).toBe('already-set-up');
    expect(admin.roleOf(second)).toBe('player');
  });

  it('refuses to promote a player that does not exist', () => {
    const result = admin.claimFirstOwner(99_999, 'ghost');
    expect(result.ok).toBe(false);
    expect(admin.needsSetup()).toBe(true);
  });

  it('records the promotion in the audit log', async () => {
    const id = await make('boss');
    admin.claimFirstOwner(id, 'boss');
    const log = admin.audit(5);
    expect(log[0]?.action).toBe('setup:first-owner');
    expect(log[0]?.actor).toBe('boss');
  });
});

describe('isAdmin — the guard the whole console rests on', () => {
  it('is false for a plain signed-in player', async () => {
    const id = await make('regular');
    expect(admin.isAdmin({ id })).toBe(false);
  });

  it('is false for nothing at all', () => {
    expect(admin.isAdmin(null)).toBe(false);
    expect(admin.isAdmin(undefined)).toBe(false);
    expect(admin.isAdmin({ id: 99_999 })).toBe(false);
  });

  it('is true only once a role is actually assigned', async () => {
    const id = await make('boss');
    expect(admin.isAdmin({ id })).toBe(false);
    admin.claimFirstOwner(id, 'boss');
    expect(admin.isAdmin({ id })).toBe(true);
  });
});

describe('roles', () => {
  let ownerId: number;
  let owner: AdminPlayer;

  beforeEach(async () => {
    ownerId = await make('boss');
    admin.claimFirstOwner(ownerId, 'boss');
    owner = asOperator(ownerId);
  });

  it('an owner can promote and demote', async () => {
    const id = await make('helper');
    expect(admin.assignRole(owner, id, 'admin').ok).toBe(true);
    expect(admin.roleOf(id)).toBe('admin');
    expect(admin.assignRole(owner, id, 'player').ok).toBe(true);
    expect(admin.roleOf(id)).toBe('player');
  });

  it('an admin cannot touch an owner', async () => {
    const helperId = await make('helper');
    admin.assignRole(owner, helperId, 'admin');
    const helper = asOperator(helperId);
    const result = admin.assignRole(helper, ownerId, 'player');
    expect(result.ok).toBe(false);
    expect(admin.roleOf(ownerId)).toBe('owner');
  });

  it('nobody can demote themselves out of the console', () => {
    const result = admin.assignRole(owner, ownerId, 'player');
    expect(result.ok).toBe(false);
    expect(admin.roleOf(ownerId)).toBe('owner');
  });

  it('the last operator cannot be removed', async () => {
    const helperId = await make('helper');
    admin.assignRole(owner, helperId, 'admin');
    const helper = asOperator(helperId);
    // Two operators exist, so removing one is fine...
    expect(admin.assignRole(owner, helperId, 'player').ok).toBe(true);
    // ...but now only the owner is left, and they cannot go either.
    expect(admin.assignRole(owner, ownerId, 'player').ok).toBe(false);
    void helper;
  });

  it('rejects a role that is not a role', () => {
    const result = admin.assignRole(owner, ownerId, 'superuser' as never);
    expect(result.ok).toBe(false);
  });
});

describe('bans', () => {
  let ownerId: number;
  let owner: AdminPlayer;
  let targetId: number;

  beforeEach(async () => {
    ownerId = await make('boss');
    admin.claimFirstOwner(ownerId, 'boss');
    owner = asOperator(ownerId);
    targetId = await make('griefer');
  });

  it('a banned player cannot sign in, and is told why', async () => {
    expect(admin.ban(owner, targetId, 'stalling matches').ok).toBe(true);
    const attempt = await players.login('griefer', 'a-good-password', 'ip');
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.reason).toBe('banned');
    expect(attempt.message).toContain('stalling matches');
  });

  it('drops every session the ban lands on', async () => {
    const session = await players.login('griefer', 'a-good-password', 'ip');
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(players.resolveSession(session.token)).not.toBeNull();

    admin.ban(owner, targetId, 'cheating');
    expect(players.resolveSession(session.token)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE player_id = ?').get(targetId)).toEqual({ n: 0 });
  });

  it('unban puts them straight back', async () => {
    admin.ban(owner, targetId, 'mistake');
    expect(admin.unban(owner, targetId).ok).toBe(true);
    expect(admin.isBanned(targetId)).toBe(false);
    await expect(players.login('griefer', 'a-good-password', 'ip')).resolves.toMatchObject({ ok: true });
  });

  it('an operator cannot ban themselves out of the console', () => {
    const result = admin.ban(owner, ownerId, 'oops');
    expect(result.ok).toBe(false);
    expect(admin.isBanned(ownerId)).toBe(false);
  });

  it('an admin cannot ban an operator; an owner can', async () => {
    const helperId = await make('helper');
    admin.assignRole(owner, helperId, 'admin');
    const helper = asOperator(helperId);
    const otherId = await make('other');
    admin.assignRole(owner, otherId, 'admin');

    expect(admin.ban(helper, otherId, 'turf war').ok).toBe(false);
    expect(admin.ban(owner, otherId, 'policy').ok).toBe(true);
  });

  it('every ban and unban lands in the audit log', () => {
    admin.ban(owner, targetId, 'flooding');
    admin.unban(owner, targetId);
    const actions = admin.audit(10).map((entry) => entry.action);
    expect(actions).toContain('ban');
    expect(actions).toContain('unban');
  });
});

describe('player search', () => {
  beforeEach(async () => {
    for (const name of ['alpha', 'alphabet', 'bravo']) await make(name);
  });

  it('finds by fragment, case-insensitively', () => {
    expect(admin.players(50, 'ALPHA').map((p) => p.username).sort()).toEqual(['alpha', 'alphabet']);
  });

  it('treats LIKE wildcards as literal text, not as a scan', () => {
    expect(admin.players(50, '%')).toHaveLength(0);
    expect(admin.players(50, '_')).toHaveLength(0);
  });

  it('lists everyone when the query is empty, and clamps the limit', () => {
    expect(admin.players(50, '')).toHaveLength(3);
    expect(() => admin.players(Number.MAX_SAFE_INTEGER, '')).not.toThrow();
    expect(() => admin.players(-1, '')).not.toThrow();
  });
});

describe('the audit log itself', () => {
  it('truncates over-long fields instead of rejecting them', async () => {
    const id = await make('boss');
    admin.claimFirstOwner(id, 'boss');
    admin.writeAudit({
      actorId: id,
      actor: 'x'.repeat(500),
      action: 'y'.repeat(500),
      target: 'z'.repeat(500),
      detail: 'd'.repeat(5000),
    });
    const entry = admin.audit(1)[0]!;
    expect(entry.actor.length).toBeLessThanOrEqual(64);
    expect(entry.action.length).toBeLessThanOrEqual(64);
    expect(entry.detail!.length).toBeLessThanOrEqual(500);
  });

  it('survives the actor being deleted', async () => {
    const id = await make('boss');
    admin.claimFirstOwner(id, 'boss');
    new MatchStore(db); // ensure foreign keys are live
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
    const entry = admin.audit(1)[0]!;
    expect(entry.actorId).toBeNull();
    // The name stays even though the row is gone — that is the point of a log.
    expect(entry.actor).toBe('boss');
  });
});
