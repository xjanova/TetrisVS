import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Server, type Socket } from 'socket.io';
import {
  ReplayRecorder, TICK_HZ, createMatch, encodeFullFrame, encodeSnapshotFrame, hash, serialize, step,
  type Inputs, type MatchState, type PlayerId,
} from '@tetrisvs/core';
import { TetrisStore, type MatchSide } from '@tetrisvs/store';
import type { ClientToServerEvents, EndReason, ServerToClientEvents, SocketData } from './protocol.js';
import { MatchmakingQueue } from './matchmaker.js';
import { normalizeRoomCode, sanitizeInput, shouldReap, type BufferedInput } from './guards.js';
import { Api } from './api.js';

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

interface Room {
  code: string;
  sockets: [string | null, string | null];
  state: MatchState;
  inputs: [BufferedInput, BufferedInput];
  /** Snapshot bytes each connected socket is known to hold, for delta encoding. */
  baselines: Map<string, Uint8Array>;
  /** Sockets that must receive a full snapshot on the next broadcast. */
  needFull: Set<string>;
  /** True once both seats were filled — leaving after this forfeits the match. */
  started: boolean;
  /** Set once the result has been announced and handed to the store. */
  concluded: boolean;
  endReason: EndReason | null;
  createdAt: number;
  /** Who is in each seat, captured at sit-down so a disconnect cannot erase it. */
  identities: [MatchSide, MatchSide];
  /** Seed plus inputs — the whole match, in a few kB. */
  recorder: ReplayRecorder;
  /** Wall clock of the last meaningful activity; the janitor reaps stale rooms. */
  touchedAt: number;
  /** Per-tick input allowance, refilled every tick. Cheap flood protection. */
  budget: [number, number];
}

// ---------------------------------------------------------------- tuning

const TICK_MS = 1000 / TICK_HZ;
/** Poll faster than the tick so the accumulator can correct timer drift. */
const PUMP_MS = 5;
/** Never try to replay more than this much wall time after a stall. */
const MAX_CATCHUP_MS = 250;
/** Hard cap on simulation steps per wake — a stalled event loop must not spiral. */
const MAX_STEPS_PER_WAKE = 8;
/** Desync hashes are for detection, not for every frame. */
const HASH_INTERVAL = 30;
/** Input messages accepted per socket per tick. A 240 Hz client needs 4. */
const INPUT_BUDGET_PER_TICK = 8;
const MAX_ROOMS = 500;
/**
 * Stop keeping a replay past this length. Gravity bottoms out under four
 * minutes, so a match this long is pathological — and 500 rooms x an unbounded
 * input log is how a game server runs out of memory.
 */
const MAX_REPLAY_TICKS = 20 * 60 * TICK_HZ;
const ROOM_IDLE_MS = 10 * 60 * 1000;
const FINISHED_ROOM_TTL_MS = 60 * 1000;
const JANITOR_MS = 15 * 1000;

// ---------------------------------------------------------------- process safety
//
// A single malformed payload used to be able to take the whole server down and
// with it every match in progress. Handlers are individually guarded below;
// these are the last line of defence so an unforeseen throw costs one socket,
// not everyone's game.

/**
 * Surviving a stray throw is worth more than a clean exit — dying takes every
 * live match with it. But surviving *forever* is wrong too: after an uncaught
 * exception the process is in an undefined state, and a box that throws
 * constantly should be restarted by its supervisor rather than limp on.
 *
 * So: absorb the occasional fault, and give up if they start arriving in bursts.
 */
const CRASH_WINDOW_MS = 60_000;
const CRASH_BUDGET = 20;
let crashes: number[] = [];

process.on('uncaughtException', (error) => {
  console.error('[tetrisvs] uncaught exception:', error);
  const now = Date.now();
  crashes = crashes.filter((at) => now - at < CRASH_WINDOW_MS);
  crashes.push(now);
  if (crashes.length > CRASH_BUDGET) {
    console.error(`[tetrisvs] ${crashes.length} uncaught exceptions in ${CRASH_WINDOW_MS / 1000}s — exiting for a clean restart`);
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[tetrisvs] unhandled rejection:', reason);
});

// ---------------------------------------------------------------- storage

const DB_FILE = resolve(process.env.TETRISVS_DB ?? './data/tetrisvs.db');
mkdirSync(dirname(DB_FILE), { recursive: true });

const store = new TetrisStore({
  file: DB_FILE,
  onError: (scope, error) => console.error(`[tetrisvs] store ${scope}:`, error),
  onMigrate: (from, to) => console.log(`[tetrisvs] schema ${from} -> ${to}`),
});
store.start();

const api = new Api({
  store,
  // Off by default: `X-Forwarded-For` is client-supplied, so honouring it
  // without a proxy in front lets anyone forge the address every rate limit is
  // keyed on.
  trustProxy: process.env.TETRISVS_TRUST_PROXY === '1',
  onError: (scope, error) => console.error(`[tetrisvs] ${scope}:`, error),
});

// ---------------------------------------------------------------- transport

const http = createServer((request, response) => {
  void api
    .handle(request, response)
    .then((handled) => {
      if (handled || response.headersSent) return;
      // Socket.IO handles its own paths before this listener runs.
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
    })
    .catch((error) => {
      console.error('[tetrisvs] http handler failed:', error);
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
});

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(http, {
  cors: { origin: true, credentials: true },
  // A client that stops answering is dropped in ~25s instead of holding a seat.
  pingInterval: 10_000,
  pingTimeout: 15_000,
  maxHttpBufferSize: 64 * 1024,
});

const rooms = new Map<string, Room>();
const matchmaking = new MatchmakingQueue();

// ---------------------------------------------------------------- guards

/**
 * Run a socket handler so a hostile or buggy payload cannot reach the process's
 * uncaught-exception path. Socket.IO does not catch handler throws itself, so
 * without this a single `null` input crashed every live match on the box.
 */
function guard<A extends unknown[]>(socket: GameSocket, name: string, handler: (...args: A) => void) {
  return (...args: A) => {
    try {
      handler(...args);
    } catch (error) {
      console.error(`[tetrisvs] ${name} failed for ${socket.id}:`, error);
    }
  };
}

/** Acks are supplied by the client and may simply be absent. */
function ack<T>(reply: unknown, value: T): void {
  if (typeof reply === 'function') {
    try {
      (reply as (v: T) => void)(value);
    } catch (error) {
      console.error('[tetrisvs] ack threw:', error);
    }
  }
}

// ---------------------------------------------------------------- rooms

function createRoomCode(): string {
  let code: string;
  do code = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

function newRoom(code: string, sockets: [string, string | null]): Room {
  return {
    code,
    sockets,
    state: createMatch(randomBytes(4).readInt32LE(0)),
    inputs: [{ pressed: [], held: [] }, { pressed: [], held: [] }],
    baselines: new Map(),
    needFull: new Set(sockets.filter((id): id is string => id !== null)),
    started: sockets[1] !== null,
    concluded: false,
    endReason: null,
    createdAt: Date.now(),
    identities: [guestSide(0), guestSide(1)],
    recorder: new ReplayRecorder(),
    touchedAt: Date.now(),
    budget: [INPUT_BUDGET_PER_TICK, INPUT_BUDGET_PER_TICK],
  };
}

function guestSide(seat: PlayerId): MatchSide {
  return { playerId: null, name: `Guest ${seat + 1}`, lines: 0, attack: 0 };
}

function seatRoom(room: Room, socket: GameSocket, playerId: PlayerId): void {
  room.sockets[playerId] = socket.id;
  room.needFull.add(socket.id);
  room.baselines.delete(socket.id);
  room.touchedAt = Date.now();
  socket.data.roomCode = room.code;
  socket.data.playerId = playerId;
  socket.join(room.code);
  // Captured now, not at the end: a player who disconnects mid-match must still
  // appear on their own result row.
  room.identities[playerId] = {
    playerId: socket.data.accountId ?? null,
    name: socket.data.username ?? `Guest ${playerId + 1}`,
    lines: 0,
    attack: 0,
  };
  if (room.sockets[0] && room.sockets[1]) room.started = true;
}

/**
 * End a match once and only once: mark it finished, tell both clients, and hand
 * the result to the store. Called from the tick loop on a top-out and from the
 * disconnect path on a forfeit.
 */
function conclude(room: Room, winner: PlayerId | null, reason: EndReason): void {
  if (room.concluded) return;
  room.concluded = true;
  if (room.state.status !== 'finished') room.state = { ...room.state, status: 'finished', winner };
  room.endReason = reason;
  room.touchedAt = Date.now();
  io.to(room.code).emit('match:ended', winner, reason);
  persist(room, winner, reason);
}

/**
 * Queue the result. `recordMatch` only appends to an in-memory queue — the
 * database write happens on the store's own timer, so the simulation never
 * waits on a disk.
 */
function persist(room: Room, winner: PlayerId | null, reason: EndReason): void {
  try {
    const ticks = room.recorder.ticks;
    // A partial replay would not reproduce the match, so an over-long one is
    // dropped rather than stored as something it is not.
    const replay = ticks > 0 && ticks <= MAX_REPLAY_TICKS
      ? { version: 1, ticks, bytes: room.recorder.encode() }
      : undefined;

    store.recordMatch({
      roomCode: room.code,
      seed: room.state.seed | 0,
      mode: 'online',
      startedAt: room.createdAt,
      endedAt: Date.now(),
      frames: room.state.frame,
      winner,
      reason,
      players: [
        { ...room.identities[0], lines: room.state.players[0].linesCleared, attack: room.state.players[0].attackSent },
        { ...room.identities[1], lines: room.state.players[1].linesCleared, attack: room.state.players[1].attackSent },
      ],
      replay,
    });
  } catch (error) {
    console.error(`[tetrisvs] failed to queue result for room ${room.code}:`, error);
  } finally {
    // Release the input log either way — 500 rooms holding one is real memory.
    room.recorder.reset();
  }
}

/**
 * Detach a socket from its room. Leaving a match that was actually running
 * forfeits it — previously the survivor's board simply froze forever with no
 * result and the room was never reclaimed.
 */
function leaveCurrentRoom(socket: GameSocket, notifyPeer: boolean): void {
  const { roomCode, playerId } = socket.data;
  delete socket.data.roomCode;
  delete socket.data.playerId;
  if (!roomCode) return;
  socket.leave(roomCode);

  const room = rooms.get(roomCode);
  if (!room || playerId === undefined || room.sockets[playerId] !== socket.id) return;

  room.sockets[playerId] = null;
  room.baselines.delete(socket.id);
  room.needFull.delete(socket.id);
  room.touchedAt = Date.now();

  if (notifyPeer) socket.to(roomCode).emit('peer:disconnected');
  if (room.started && !room.concluded) {
    conclude(room, playerId === 0 ? 1 : 0, 'forfeit');
  }
  if (!room.sockets[0] && !room.sockets[1]) rooms.delete(roomCode);
}

// ---------------------------------------------------------------- connections

io.on('connection', (socket: GameSocket) => {
  // Identity is established once, from the token, before any game event is
  // handled. A client can send whatever it likes in `auth`; only a token that
  // resolves to a live session in the database becomes an account.
  try {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const player = store.players.resolveSession(token);
    if (player) {
      socket.data.accountId = player.id;
      socket.data.username = player.username;
      store.players.touch(player.id);
    }
  } catch (error) {
    console.error(`[tetrisvs] session lookup failed for ${socket.id}:`, error);
  }

  socket.on('matchmaking:join', guard(socket, 'matchmaking:join', (pool: unknown, reply: unknown) => {
    leaveCurrentRoom(socket, true);
    // One pool for now. Anything a client sends is coerced into it rather than
    // trusted, so a crafted pool name cannot shard players into private queues.
    void pool;
    const safePool = 'v1-default';

    if (rooms.size >= MAX_ROOMS) {
      ack(reply, { searching: false });
      return;
    }

    const pair = matchmaking.enqueue(socket.id, safePool);
    if (!pair) {
      socket.emit('matchmaking:searching');
      ack(reply, { searching: true });
      return;
    }

    const first = io.sockets.sockets.get(pair[0].socketId) as GameSocket | undefined;
    const second = io.sockets.sockets.get(pair[1].socketId) as GameSocket | undefined;
    if (!first || !second) {
      // Exactly one survivor goes back to the front of the queue. Re-enqueuing
      // both used to pair them with each other and throw the pair away, which
      // left the caller stuck on SEARCHING forever.
      const survivor = first ?? second;
      if (survivor) {
        matchmaking.enqueue(survivor.id, safePool);
        survivor.emit('matchmaking:searching');
      }
      ack(reply, { searching: Boolean(survivor && survivor.id === socket.id) });
      return;
    }

    const code = createRoomCode();
    const room = newRoom(code, [first.id, second.id]);
    rooms.set(code, room);
    seatRoom(room, first, 0);
    seatRoom(room, second, 1);
    first.emit('matchmaking:matched', { roomCode: code, playerId: 0 });
    second.emit('matchmaking:matched', { roomCode: code, playerId: 1 });
    io.to(code).emit('room:ready', code);
    ack(reply, { searching: false });
  }));

  socket.on('matchmaking:cancel', guard(socket, 'matchmaking:cancel', (reply: unknown) => {
    ack(reply, { cancelled: matchmaking.remove(socket.id) });
  }));

  socket.on('room:create', guard(socket, 'room:create', (reply: unknown) => {
    matchmaking.remove(socket.id);
    leaveCurrentRoom(socket, true);
    if (rooms.size >= MAX_ROOMS) {
      ack(reply, { roomCode: '', playerId: 0 });
      return;
    }
    const code = createRoomCode();
    const room = newRoom(code, [socket.id, null]);
    rooms.set(code, room);
    seatRoom(room, socket, 0);
    ack(reply, { roomCode: code, playerId: 0 });
  }));

  socket.on('room:join', guard(socket, 'room:join', (rawCode: unknown, reply: unknown) => {
    matchmaking.remove(socket.id);
    leaveCurrentRoom(socket, true);

    // `rawCode.trim()` on a non-string used to throw straight past Socket.IO
    // and kill the process — a one-line denial of service for every match.
    const code = normalizeRoomCode(rawCode);
    if (!code) {
      ack(reply, { ok: false, reason: 'Invalid room code' });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      ack(reply, { ok: false, reason: 'Room not found' });
      return;
    }
    if (room.sockets[1]) {
      ack(reply, { ok: false, reason: 'Room is full' });
      return;
    }
    if (room.state.status === 'finished') {
      ack(reply, { ok: false, reason: 'Match already finished' });
      return;
    }

    seatRoom(room, socket, 1);
    ack(reply, { ok: true, playerId: 1 });
    io.to(code).emit('room:ready', code);
  }));

  socket.on('match:input', guard(socket, 'match:input', (unsafeInput: unknown) => {
    const { roomCode, playerId } = socket.data;
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room || playerId === undefined) return;
    if (room.budget[playerId] <= 0) return;
    room.budget[playerId]--;

    const safe = sanitizeInput(unsafeInput);
    if (!safe) return;
    const buffered = room.inputs[playerId];
    // Presses union across everything that arrived since the last tick so a tap
    // between ticks is never swallowed; holds are level-triggered, last wins.
    for (const action of safe.pressed) if (!buffered.pressed.includes(action)) buffered.pressed.push(action);
    buffered.held = safe.held;
    room.touchedAt = Date.now();
  }));

  socket.on('match:resync', guard(socket, 'match:resync', () => {
    const { roomCode } = socket.data;
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room) return;
    room.baselines.delete(socket.id);
    room.needFull.add(socket.id);
  }));

  socket.on('disconnect', guard(socket, 'disconnect', () => {
    matchmaking.remove(socket.id);
    leaveCurrentRoom(socket, true);
  }));
});

// ---------------------------------------------------------------- simulation

function broadcast(room: Room, events: ReturnType<typeof step>['events']): void {
  const snapshot = serialize(room.state);
  const digest = room.state.frame % HASH_INTERVAL === 0 ? hash(room.state) : null;

  let sharedDelta: Uint8Array | null = null;
  let sharedBase: Uint8Array | null = null;
  let fullFrame: Uint8Array | null = null;

  for (const socketId of room.sockets) {
    if (!socketId) continue;
    const target = io.sockets.sockets.get(socketId) as GameSocket | undefined;
    if (!target) continue;

    const base = room.needFull.has(socketId) ? null : room.baselines.get(socketId) ?? null;
    let frame: Uint8Array;
    if (!base) {
      fullFrame ??= encodeFullFrame(snapshot);
      frame = fullFrame;
    } else if (base === sharedBase && sharedDelta) {
      frame = sharedDelta;
    } else {
      frame = encodeSnapshotFrame(base, snapshot);
      sharedBase = base;
      sharedDelta = frame;
    }

    target.emit('match:update', {
      frame: room.state.frame,
      hash: digest,
      events,
      snapshot: frame,
      full: !base,
    });
    room.baselines.set(socketId, snapshot);
    room.needFull.delete(socketId);
  }
}

function tickRooms(): void {
  for (const room of rooms.values()) {
    room.budget[0] = INPUT_BUDGET_PER_TICK;
    room.budget[1] = INPUT_BUDGET_PER_TICK;
    if (!room.sockets[0] || !room.sockets[1] || room.state.status === 'finished') continue;

    const inputs: Inputs = [0, 1].map((index) => ({
      frame: room.state.frame,
      pressed: [...room.inputs[index as PlayerId].pressed],
      held: [...room.inputs[index as PlayerId].held],
    })) as Inputs;
    room.inputs[0].pressed.length = 0;
    room.inputs[1].pressed.length = 0;

    // One array append per tick — cheap enough to sit on the hot path, and it
    // is the entire replay.
    if (room.recorder.ticks < MAX_REPLAY_TICKS) room.recorder.record(inputs);

    const result = step(room.state, inputs);
    room.state = result.state;
    room.touchedAt = Date.now();
    broadcast(room, result.events);
    if (room.state.status === 'finished') conclude(room, room.state.winner, 'topout');
  }
}

/**
 * Fixed timestep with drift correction.
 *
 * `setInterval(1000/60)` is truncated to 16 ms by Node and loses every tick the
 * event loop is late for, so matches silently ran slow under load and the two
 * clients disagreed about how much time had passed. Polling faster than the
 * tick and draining an accumulator keeps the simulation on real 60 Hz, while
 * the catch-up caps stop a stalled process from replaying minutes at once.
 */
let previousPump = Date.now();
let accumulator = 0;

const pump = setInterval(() => {
  const now = Date.now();
  const elapsed = Math.min(MAX_CATCHUP_MS, Math.max(0, now - previousPump));
  previousPump = now;
  accumulator += elapsed;

  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_WAKE) {
    tickRooms();
    accumulator -= TICK_MS;
    steps++;
  }
  // Whatever we could not replay is dropped rather than owed forever.
  if (accumulator > TICK_MS) accumulator = 0;
}, PUMP_MS);
pump.unref();

const janitor = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const reap = shouldReap({
      empty: !room.sockets[0] && !room.sockets[1],
      finished: room.state.status === 'finished',
      idleMs: now - room.touchedAt,
    }, FINISHED_ROOM_TTL_MS, ROOM_IDLE_MS);
    if (reap) rooms.delete(code);
  }
}, JANITOR_MS);
janitor.unref();

// ---------------------------------------------------------------- lifecycle

const port = Number(process.env.PORT ?? 3001);

// A server that cannot bind must die, not linger. Without this the
// uncaught-exception net above swallows EADDRINUSE and leaves a process that
// looks alive to a supervisor while serving nothing at all.
http.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`[tetrisvs] cannot listen on :${port}: ${error.code ?? error.message}`);
  store.close();
  process.exit(1);
});

http.listen(port, () => console.log(`TetrisVS authoritative server listening on :${port} (db ${DB_FILE})`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`[tetrisvs] ${signal} — closing`);
    clearInterval(pump);
    clearInterval(janitor);
    // Flush queued results before the process goes away.
    store.close();
    io.close(() => http.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
