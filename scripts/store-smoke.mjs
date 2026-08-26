/**
 * End-to-end check of persistence against a real server process.
 *
 * Proves four things unit tests cannot:
 *   1. an account registered over HTTP can sign a websocket in
 *   2. a match played over sockets lands in the database attributed to the
 *      right players, and moves the leaderboard
 *   3. the replay downloaded over HTTP replays to the *same state hash* the
 *      client saw over the wire — determinism holding across the simulation,
 *      the delta-compressed wire format, and the database
 *   4. recording a result does not stall the 60 Hz loop
 *
 *   node scripts/store-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import {
  createMatch, decodeReplay, decodeSnapshotFrame, deserialize, hash, replayInputs, stepMany,
} from '@tetrisvs/core';

const PORT = Number(process.env.PORT ?? 3010);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workdir = mkdtempSync(join(tmpdir(), 'tetrisvs-store-'));
const dbFile = join(workdir, 'smoke.db');
let server;
const report = {};

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['packages/server/dist/server.js'], {
      env: { ...process.env, PORT: String(PORT), TETRISVS_DB: dbFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const onData = (chunk) => {
      log += chunk.toString();
      if (log.includes('listening on')) resolve(log);
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('exit', (code) => reject(new Error(`server exited ${code}\n${log}`)));
    setTimeout(() => reject(new Error(`server did not start\n${log}`)), 15_000);
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body, headers: response.headers };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'], forceNew: true, auth: token ? { token } : {} });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
}

/** Mirrors the client's SnapshotStream so we can follow the same delta chain. */
function follower() {
  let baseline = null;
  return (update) => {
    const bytes = update.snapshot instanceof Uint8Array
      ? update.snapshot
      : new Uint8Array(update.snapshot?.data ?? update.snapshot);
    const next = decodeSnapshotFrame(update.full ? null : baseline, bytes);
    baseline = next;
    return deserialize(next);
  };
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const banner = await startServer();
  must(banner.includes('schema 0 -> 1'), 'expected the schema to be created on first run');
  report.migrated = true;

  // ---- 1. accounts over HTTP ------------------------------------------
  const alpha = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: 'alpha', password: 'a-good-password' }) });
  const bravo = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: 'bravo', password: 'a-good-password' }) });
  must(alpha.status === 201 && bravo.status === 201, `register failed: ${alpha.status}/${bravo.status}`);
  must(alpha.body.token && alpha.body.token !== bravo.body.token, 'tokens must be distinct');

  const dupe = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: 'ALPHA', password: 'a-good-password' }) });
  must(dupe.status === 400, 'a taken name must be rejected case-insensitively');

  const wrongPassword = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: 'alpha', password: 'nope' }) });
  must(wrongPassword.status === 401, 'a wrong password must be a 401');

  const me = await api('/api/me', { headers: { authorization: `Bearer ${alpha.body.token}` } });
  must(me.status === 200 && me.body.player.username === 'alpha', '/api/me should resolve the bearer token');
  const anon = await api('/api/me');
  must(anon.status === 401, '/api/me without a token must be a 401');
  report.accounts = 'verified';

  // ---- 2. play a match over sockets -------------------------------------
  const one = await connect(alpha.body.token);
  const two = await connect(bravo.body.token);
  const ready = Promise.all([one, two].map((socket) => new Promise((resolve) => socket.on('room:ready', resolve))));
  one.emit('matchmaking:join', 'v1-default', () => {});
  two.emit('matchmaking:join', 'v1-default', () => {});
  const [code] = await ready;
  report.room = code;

  const apply = follower();
  let lastState = null;
  let updates = 0;
  const frameTimes = [];
  let previous = 0;
  one.on('match:update', (update) => {
    lastState = apply(update);
    updates++;
    const now = performance.now();
    if (previous) frameTimes.push(now - previous);
    previous = now;
  });

  const ended = new Promise((resolve) => one.on('match:ended', (winner, reason) => resolve({ winner, reason })));

  // Drive both boards hard. Stacking this fast tops somebody out in a few
  // seconds, which is the ending we most want to exercise; if it does not, we
  // force the forfeit path instead.
  const drive = setInterval(() => {
    one.emit('match:input', { frame: 0, pressed: ['hardDrop'], held: [] });
    two.emit('match:input', { frame: 0, pressed: ['rotCW'], held: ['left'] });
  }, 120);
  let result = await Promise.race([ended, sleep(12_000).then(() => null)]);
  clearInterval(drive);

  must(updates > 200, `expected a ~60 Hz stream, saw ${updates} updates`);
  must(lastState !== null, 'never decoded a snapshot');
  const liveHash = hash(lastState);
  const liveFrame = lastState.frame;

  if (!result) {
    two.disconnect();
    result = await Promise.race([ended, sleep(8000).then(() => null)]);
  }
  must(result, 'the match never ended');
  must(result.reason === 'topout' || result.reason === 'forfeit', `unexpected reason ${result.reason}`);
  report.firstMatch = { reason: result.reason, winner: result.winner, frames: liveFrame };

  // ---- 3. the result reached the database -------------------------------
  await sleep(1200); // the write queue flushes on its own timer
  const recent = await api('/api/matches?limit=5');
  must(recent.status === 200 && recent.body.matches.length === 1, `expected one recorded match, got ${recent.body.matches?.length}`);
  const match = recent.body.matches[0];
  must(match.roomCode === code, `match room ${match.roomCode} != ${code}`);
  must(match.reason === result.reason, `stored reason ${match.reason} != ${result.reason}`);
  must(match.players[0].name === 'alpha' && match.players[1].name === 'bravo', 'players must be attributed by account');
  must(match.players[0].playerId && match.players[1].playerId, 'both seats should carry an account id');
  must(match.hasReplay, 'a replay should have been stored');
  report.match = { id: match.id, frames: match.frames, winner: match.winner, ratingDelta: match.players.map((p) => p.ratingDelta) };

  const board = await api('/api/leaderboard');
  must(board.body.leaderboard.length === 2, 'both players should be on the leaderboard');
  const winnerName = result.winner === 0 ? 'alpha' : result.winner === 1 ? 'bravo' : null;
  if (winnerName) {
    must(board.body.leaderboard[0].username === winnerName, `${winnerName} won but is not ranked first`);
    must(board.body.leaderboard[0].rating > 1000 && board.body.leaderboard[1].rating < 1000, 'rating should have moved');
  }
  report.leaderboard = board.body.leaderboard.map((row) => `${row.rank}. ${row.username} ${row.rating}`);

  // ---- 4. the replay reproduces exactly what the client saw -------------
  const replay = await api(`/api/matches/${match.id}/replay`);
  must(replay.status === 200, 'replay download failed');
  const words = decodeReplay(new Uint8Array(replay.body));
  const seed = Number(replay.headers.get('x-match-seed'));
  const rebuilt = stepMany(createMatch(seed), replayInputs(words)).state;

  must(rebuilt.frame === liveFrame, `replay ended at frame ${rebuilt.frame}, client saw ${liveFrame}`);
  if (result.reason === 'topout') {
    // The client's last snapshot IS the finished state, so the hashes must be
    // identical: simulation, wire format, and database all agree.
    must(hash(rebuilt) === liveHash, `replay hash ${hash(rebuilt)} != live hash ${liveHash}`);
  } else {
    // A forfeit stamps `finished` after the last broadcast, so compare the part
    // the inputs actually produced.
    for (const seat of [0, 1]) {
      must(
        JSON.stringify(rebuilt.players[seat].board) === JSON.stringify(lastState.players[seat].board),
        `replayed board ${seat} differs from the one the client rendered`,
      );
    }
  }
  report.replay = {
    bytes: replay.body.length,
    ticks: words.length,
    bytesPerTick: Number((replay.body.length / words.length).toFixed(2)),
    reproducesLiveStream: true,
  };

  // ---- 5. the tick loop kept its rate through all of it ------------------
  frameTimes.sort((a, b) => a - b);
  const p99 = frameTimes[Math.floor(frameTimes.length * 0.99)] ?? 0;
  report.tick = {
    updates,
    medianGapMs: Number((frameTimes[Math.floor(frameTimes.length / 2)] ?? 0).toFixed(2)),
    p99GapMs: Number(p99.toFixed(2)),
  };
  must(p99 < 120, `a tick gap of ${p99.toFixed(1)} ms means the loop stalled on I/O`);

  const health = await api('/health');
  must(health.body.writeQueue.written >= 1, 'the write queue should report the match it wrote');
  must(health.body.writeQueue.failed === 0, 'no write should have failed');
  report.writeQueue = health.body.writeQueue;

  // ---- 5b. the forfeit path also records --------------------------------
  const three = await connect(alpha.body.token);
  const four = await connect(bravo.body.token);
  const ready2 = Promise.all([three, four].map((socket) => new Promise((resolve) => socket.on('room:ready', resolve))));
  const ended2 = new Promise((resolve) => three.on('match:ended', (winner, reason) => resolve({ winner, reason })));
  three.emit('matchmaking:join', 'v1-default', () => {});
  four.emit('matchmaking:join', 'v1-default', () => {});
  await ready2;
  await sleep(1500);
  four.disconnect();
  const forfeit = await Promise.race([ended2, sleep(6000).then(() => null)]);
  must(forfeit && forfeit.reason === 'forfeit', `expected a forfeit, got ${JSON.stringify(forfeit)}`);
  must(forfeit.winner === 0, 'the survivor should win by forfeit');
  await sleep(1200);
  const both = await api('/api/matches?limit=5');
  must(both.body.matches.length === 2, `expected two recorded matches, got ${both.body.matches.length}`);
  three.disconnect();
  report.forfeitPath = 'verified';

  // ---- 6. anonymous stats carry nobody ----------------------------------
  const stats = await api('/api/stats');
  must(stats.body.totals.matches === 2, `daily totals should count both matches, saw ${stats.body.totals.matches}`);
  const serialized = JSON.stringify(stats.body);
  for (const leak of ['alpha', 'bravo', alpha.body.token, bravo.body.token]) {
    must(!serialized.includes(leak), `aggregate stats leaked "${leak.slice(0, 12)}"`);
  }
  report.anonymousStats = 'verified';

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('FAILED:', error.message);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  if (server && !server.killed) server.kill();
  await sleep(400);
  try { rmSync(workdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* temp dir */ }
}
