/**
 * Hostile-payload smoke test against a running authoritative server.
 *
 * Every payload here used to reach an unguarded property access inside a
 * Socket.IO handler, which Socket.IO does not catch — one of them was enough to
 * take the process down and end every match on the box. The test asserts the
 * server is still answering afterwards and still plays a normal match.
 *
 *   node packages/server/dist/server.js &
 *   node scripts/server-abuse-smoke.mjs
 */

import { io } from 'socket.io-client';

const URL = process.env.TETRISVS_SERVER ?? 'http://127.0.0.1:3001';
const HEALTH = `${URL}/health`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function health() {
  const response = await fetch(HEALTH);
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, timeout: 5000 });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const HOSTILE_INPUTS = [
  null,
  undefined,
  0,
  'left',
  [],
  {},
  { frame: 'soon' },
  { pressed: null, held: null },
  { pressed: 'left', held: 'right' },
  { pressed: [null, undefined, 1, {}, []], held: [Symbol.iterator?.toString?.() ?? 'x'] },
  { pressed: new Array(500_000).fill('left'), held: new Array(500_000).fill('rotCW') },
  { pressed: ['left'], held: ['left'], extra: 'x'.repeat(4096) },
];

const HOSTILE_CODES = [null, undefined, 0, 42, [], {}, true, '', '  ', 'x'.repeat(9000), '<script>', '../../etc'];

async function main() {
  const before = await health();
  console.log('health before:', before);

  const attacker = await connect();
  console.log('connected as', attacker.id);

  // 1. Malformed match:input, including two half-megabyte arrays.
  for (const payload of HOSTILE_INPUTS) attacker.emit('match:input', payload);

  // 2. Malformed room codes, with and without an ack callback.
  for (const code of HOSTILE_CODES) {
    attacker.emit('room:join', code, () => {});
    attacker.emit('room:join', code); // no ack at all — `reply(...)` used to throw
  }

  // 3. Acks omitted everywhere else too.
  attacker.emit('room:create');
  attacker.emit('matchmaking:join', 'v1-default');
  attacker.emit('matchmaking:join', { evil: true }, () => {});
  attacker.emit('matchmaking:cancel');
  attacker.emit('match:resync');

  // 4. Input flood while not in a room.
  for (let i = 0; i < 3000; i++) attacker.emit('match:input', { frame: i, pressed: ['hardDrop'], held: [] });

  await sleep(1500);
  const during = await health();
  console.log('health after abuse:', during);
  if (during.uptimeSeconds < before.uptimeSeconds) throw new Error('server restarted — it crashed');

  // 5. The server must still run a real match afterwards.
  attacker.disconnect();
  const [one, two] = await Promise.all([connect(), connect()]);
  const ready = Promise.all([one, two].map((socket) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('room:ready timeout')), 8000);
    socket.on('room:ready', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  })));
  one.emit('matchmaking:join', 'v1-default', () => {});
  two.emit('matchmaking:join', 'v1-default', () => {});
  const codes = await ready;
  if (codes[0] !== codes[1]) throw new Error(`paired into different rooms: ${codes}`);
  console.log('paired into room', codes[0]);

  let updates = 0;
  let fullFrames = 0;
  let bytes = 0;
  one.on('match:update', (update) => {
    updates++;
    if (update.full) fullFrames++;
    bytes += update.snapshot?.byteLength ?? update.snapshot?.length ?? 0;
  });
  one.emit('match:input', { frame: 0, pressed: ['hardDrop'], held: ['left'] });
  await sleep(2000);

  one.disconnect();
  two.disconnect();
  await sleep(500);

  const after = await health();
  console.log('health after match:', after);
  console.log(`updates=${updates} fullFrames=${fullFrames} avgFrameBytes=${(bytes / Math.max(1, updates)).toFixed(1)}`);

  if (updates < 60) throw new Error(`expected a ~60 Hz stream, saw ${updates} updates in 2s`);
  if (fullFrames !== 1) throw new Error(`expected exactly one keyframe, saw ${fullFrames}`);
  if (bytes / updates > 200) throw new Error(`frames are not being delta-compressed (${bytes / updates} B avg)`);
  if (after.uptimeSeconds < before.uptimeSeconds) throw new Error('server restarted');

  console.log('\nOK — server survived every hostile payload and still plays a match.');
  process.exit(0);
}

main().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
