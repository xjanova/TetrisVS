import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  TICK_HZ, createMatch, hash, serialize, step,
  type ActionName, type Inputs, type MatchState, type PlayerId, type PlayerInput,
} from '@tetrisvs/core';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from './protocol.js';
import { MatchmakingQueue } from './matchmaker.js';

interface Room {
  code: string;
  sockets: [string | null, string | null];
  state: MatchState;
  inputs: [BufferedInput, BufferedInput];
}

interface BufferedInput {
  pressed: ActionName[];
  held: ActionName[];
}

const ACTIONS = new Set<ActionName>(['left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold']);
const http = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ service: 'tetrisvs-authoritative', status: 'ok' }));
});
const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(http, {
  cors: { origin: true, credentials: true },
});
const rooms = new Map<string, Room>();
const matchmaking = new MatchmakingQueue();

function createRoomCode() {
  let code: string;
  do code = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

function idle(frame: number): PlayerInput {
  return { frame, pressed: [], held: [] };
}

function newRoom(code: string, sockets: [string, string | null]): Room {
  return {
    code,
    sockets,
    state: createMatch(randomBytes(4).readInt32LE(0)),
    inputs: [{ pressed: [], held: [] }, { pressed: [], held: [] }],
  };
}

function leaveCurrentRoom(socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>, notifyPeer: boolean) {
  const { roomCode, playerId } = socket.data;
  if (!roomCode || playerId === undefined) return;
  const room = rooms.get(roomCode);
  if (room && room.sockets[playerId] === socket.id) {
    room.sockets[playerId] = null;
    if (notifyPeer) socket.to(roomCode).emit('peer:disconnected');
    if (!room.sockets[0] && !room.sockets[1]) rooms.delete(roomCode);
  }
  socket.leave(roomCode);
  delete socket.data.roomCode;
  delete socket.data.playerId;
}

function sanitize(input: PlayerInput): BufferedInput | null {
  if (!Array.isArray(input.pressed) || !Array.isArray(input.held)) return null;
  return {
    pressed: input.pressed.filter((action): action is ActionName => ACTIONS.has(action)),
    held: input.held.filter((action): action is ActionName => ACTIONS.has(action)),
  };
}

io.on('connection', (socket) => {
  socket.on('matchmaking:join', (pool, reply) => {
    leaveCurrentRoom(socket, true);
    const safePool = pool === 'v1-default' ? pool : 'v1-default';
    const pair = matchmaking.enqueue(socket.id, safePool);
    if (!pair) {
      socket.emit('matchmaking:searching');
      reply({ searching: true });
      return;
    }
    const first = io.sockets.sockets.get(pair[0].socketId);
    const second = io.sockets.sockets.get(pair[1].socketId);
    if (!first || !second) {
      if (first) matchmaking.enqueue(first.id, safePool);
      if (second) matchmaking.enqueue(second.id, safePool);
      reply({ searching: true });
      return;
    }
    const code = createRoomCode();
    rooms.set(code, newRoom(code, [first.id, second.id]));
    for (const [playerId, playerSocket] of [[0, first], [1, second]] as const) {
      playerSocket.data.roomCode = code;
      playerSocket.data.playerId = playerId;
      playerSocket.join(code);
      playerSocket.emit('matchmaking:matched', { roomCode: code, playerId });
    }
    io.to(code).emit('room:ready', code);
    reply({ searching: false });
  });

  socket.on('matchmaking:cancel', (reply) => {
    reply({ cancelled: matchmaking.remove(socket.id) });
  });

  socket.on('room:create', (reply) => {
    matchmaking.remove(socket.id);
    leaveCurrentRoom(socket, true);
    const code = createRoomCode();
    rooms.set(code, newRoom(code, [socket.id, null]));
    socket.data.roomCode = code;
    socket.data.playerId = 0;
    socket.join(code);
    reply({ roomCode: code, playerId: 0 });
  });

  socket.on('room:join', (rawCode, reply) => {
    matchmaking.remove(socket.id);
    leaveCurrentRoom(socket, true);
    const code = rawCode.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.sockets[1]) {
      reply({ ok: false, reason: room ? 'Room is full' : 'Room not found' });
      return;
    }
    room.sockets[1] = socket.id;
    socket.data.roomCode = code;
    socket.data.playerId = 1;
    socket.join(code);
    reply({ ok: true, playerId: 1 });
    io.to(code).emit('room:ready', code);
  });

  socket.on('match:input', (unsafeInput) => {
    const { roomCode, playerId } = socket.data;
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room || playerId === undefined) return;
    const safe = sanitize(unsafeInput);
    if (!safe) return;
    const buffered = room.inputs[playerId];
    buffered.pressed = [...new Set([...buffered.pressed, ...safe.pressed])];
    buffered.held = safe.held;
  });

  socket.on('disconnect', () => {
    matchmaking.remove(socket.id);
    leaveCurrentRoom(socket, true);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.sockets[0] || !room.sockets[1] || room.state.status === 'finished') continue;
    const inputs: Inputs = [0, 1].map((index) => ({
      frame: room.state.frame,
      pressed: [...room.inputs[index as PlayerId].pressed],
      held: [...room.inputs[index as PlayerId].held],
    })) as Inputs;
    room.inputs[0].pressed = [];
    room.inputs[1].pressed = [];
    const result = step(room.state, inputs);
    room.state = result.state;
    const snapshot = Buffer.from(serialize(room.state)).toString('base64');
    io.to(room.code).emit('match:update', { frame: room.state.frame, hash: hash(room.state), events: result.events, snapshot });
    if (room.state.status === 'finished') io.to(room.code).emit('match:ended', room.state.winner);
  }
}, 1000 / TICK_HZ).unref();

const port = Number(process.env.PORT ?? 3001);
http.listen(port, () => console.log(`TetrisVS authoritative server listening on :${port}`));
