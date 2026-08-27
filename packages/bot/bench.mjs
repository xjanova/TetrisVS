/**
 * How long the bot takes to think, in milliseconds.
 *
 * A script rather than a test: the numbers move with machine load, so they are
 * worth reading and worth comparing between changes, but they make a terrible
 * pass/fail gate. `npm run bench -w @tetrisvs/bot`
 */
import { DEFAULT_CONFIG, createMatch, idleInput, step } from '@tetrisvs/core';
import { Bot, DIFFICULTIES, DIFFICULTY_ORDER } from './dist/index.js';

const SOLO = { ...DEFAULT_CONFIG, solo: true };
const TICKS = 6000;

console.log(`node ${process.version} · ${TICKS} ticks (${(TICKS / 60).toFixed(0)}s of play) per difficulty\n`);
console.log('difficulty   lines  pieces  searches   median    p95     max   survived');

for (const difficulty of DIFFICULTY_ORDER) {
  const bot = new Bot(0, DIFFICULTIES[difficulty]);
  let state = createMatch(20260827, SOLO);
  const samples = [];
  let pieces = 0;

  for (let i = 0; i < TICKS; i++) {
    const started = performance.now();
    const thought = bot.think(state);
    const elapsed = performance.now() - started;
    if (elapsed > 0.05) samples.push(elapsed);
    if (thought.pressed.includes('hardDrop')) pieces++;
    state = step(state, [thought, idleInput(state.frame)], SOLO).state;
    if (state.status === 'finished') break;
  }

  samples.sort((a, b) => a - b);
  const at = (q) => (samples[Math.floor(samples.length * q)] ?? 0).toFixed(2);
  console.log(
    difficulty.padEnd(11) +
    String(state.players[0].linesCleared).padStart(6) +
    String(pieces).padStart(8) +
    String(bot.searches).padStart(10) +
    at(0.5).padStart(9) + ' ms' +
    at(0.95).padStart(6) + ' ms' +
    (samples[samples.length - 1] ?? 0).toFixed(2).padStart(7) + ' ms' +
    (state.status === 'finished' ? '   topped out' : '   still alive'),
  );
}
console.log('\nA 60 Hz frame is 16.67 ms. The bot searches once per piece, not once per tick.');
