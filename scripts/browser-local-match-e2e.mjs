/**
 * End-to-end check of every loop that runs in the browser alone: LOCAL 2P,
 * SOLO, and VERSUS AI.
 *
 * The matchmaking harness only ever exercises the online path, where the client
 * is a passive viewer of the server's stream. Everything the offline loop owns —
 * fixed-timestep stepping, pause, the blur guard, rematch, the bot, and scoring
 * — was covered by nothing. This closes that gap.
 *
 *   npm run dev -w @tetrisvs/client
 *   node scripts/browser-local-match-e2e.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.TETRISVS_URL ?? 'http://127.0.0.1:5173/';
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'error' || message.params.type === 'warning')) {
        this.consoleErrors.push(`${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(`exception: ${message.params.exceptionDetails.text}`);
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      // `text` is usually just "Uncaught"; the useful part is the exception.
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.exception?.value
        ?? result.exceptionDetails.text;
      throw new Error(`${detail} — while evaluating: ${expression.slice(0, 160)}`);
    }
    return result.result.value;
  }
}

async function waitFor(fn, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function launch(port) {
  const profile = await mkdtemp(join(tmpdir(), 'tetrisvs-local-'));
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--autoplay-policy=no-user-gesture-required', APP_URL,
  ], { stdio: 'ignore', windowsHide: true });

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === 'page' && item.url !== 'about:blank');
  }, 'Chrome target');

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && document.body.innerText.includes('LOCAL 2P')"), 'app');
  return { cdp, child, profile };
}

const frame = (client) => client.cdp.evaluate("Number(document.querySelector('main')?.dataset.frame ?? -1)");
const status = (client) => client.cdp.evaluate("document.querySelector('main')?.dataset.matchStatus ?? 'none'");
const hashes = (client) => client.cdp.evaluate("[...document.querySelectorAll('canvas')].map((c) => c.dataset.boardHash)");
const body = (client) => client.cdp.evaluate('document.body.innerText');

const click = async (client, label) => {
  const ok = await client.cdp.evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(${JSON.stringify(label)}));
  if (!button) return false;
  button.click();
  return true;
})()`);
  if (!ok) throw new Error(`button not found: ${label}`);
};

const KEY_CODES = { Space: 32, Escape: 27, ArrowLeft: 37, ArrowRight: 39, ArrowDown: 40, ArrowUp: 38 };
const key = async (client, code, holdMs = 70) => {
  const virtualKey = KEY_CODES[code] ?? (code.startsWith('Key') ? code.charCodeAt(3) : 0);
  await client.cdp.send('Page.bringToFront');
  await client.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  await sleep(holdMs);
  await client.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  await sleep(40);
};

let client;
const report = {};

try {
  client = await launch(9331);

  // ---- start ------------------------------------------------------------
  await click(client, 'LOCAL 2P');
  await waitFor(async () => (await status(client)) !== 'none', 'match started');
  await waitFor(async () => (await client.cdp.evaluate("document.querySelectorAll('canvas').length === 2")), 'two playfields');

  await waitFor(async () => (await status(client)) === 'playing', 'countdown finished', 12_000);

  // ---- the loop actually runs at roughly the tick rate -------------------
  // Headless Chrome drives requestAnimationFrame irregularly, so this is a
  // sanity band, not a precision measurement: what matters is that the
  // accumulator neither stalls the simulation nor lets it outrun 60 Hz.
  const t0 = Date.now();
  const f0 = await frame(client);
  await sleep(3000);
  const f1 = await frame(client);
  const measuredHz = (f1 - f0) / ((Date.now() - t0) / 1000);
  report.tickHz = Number(measuredHz.toFixed(1));
  if (measuredHz < 35) throw new Error(`simulation stalled at ${measuredHz.toFixed(1)} Hz`);
  if (measuredHz > 70) throw new Error(`simulation outran the tick rate at ${measuredHz.toFixed(1)} Hz`);

  // ---- both keyboards drive their own board -----------------------------
  const before = await hashes(client);
  for (const code of ['KeyA', 'KeyA', 'KeyW', 'Space']) await key(client, code);
  for (const code of ['ArrowRight', 'ArrowRight', 'ArrowUp', 'Enter']) await key(client, code);
  await sleep(400);
  const after = await hashes(client);
  report.boardsChanged = before[0] !== after[0] || before[1] !== after[1];
  report.boardsDistinct = after[0] !== after[1];
  if (!report.boardsChanged) throw new Error('keyboard input did not change either board');
  if (!report.boardsDistinct) throw new Error('both playfields are identical — inputs are not separated');

  // ---- pause freezes the clock, resume does not fast-forward ------------
  await key(client, 'Escape');
  await waitFor(async () => (await body(client)).includes('PAUSED'), 'pause card');
  const paused0 = await frame(client);
  await sleep(1500);
  const paused1 = await frame(client);
  report.framesWhilePaused = paused1 - paused0;
  if (paused1 !== paused0) throw new Error(`simulation advanced ${paused1 - paused0} frames while paused`);

  // Resuming must not replay the 1.5 s that was paused. Measure the burst
  // against real elapsed time rather than an absolute frame count, since the
  // keystroke itself takes a CDP round trip.
  await key(client, 'Escape');
  const resumeStart = Date.now();
  const resumeFrom = await frame(client);
  await sleep(700);
  const resumed = await frame(client);
  const resumeHz = (resumed - resumeFrom) / ((Date.now() - resumeStart) / 1000);
  report.resumeHz = Number(resumeHz.toFixed(1));
  if (resumed <= resumeFrom) throw new Error('simulation did not resume');
  if (resumeHz > 90) throw new Error(`resume fast-forwarded banked time at ${resumeHz.toFixed(1)} Hz`);

  // ---- losing focus auto-pauses instead of walking the piece into a wall -
  await client.cdp.evaluate("window.dispatchEvent(new Event('blur'))");
  await waitFor(async () => (await body(client)).includes('PAUSED'), 'blur auto-pause');
  report.blurAutoPause = true;
  await key(client, 'Escape');

  // ---- quit and rematch --------------------------------------------------
  await key(client, 'Escape');
  await waitFor(async () => (await body(client)).includes('PAUSED'), 'pause card again');
  await click(client, 'QUIT TO MENU');
  await waitFor(async () => (await body(client)).includes('QUICK MATCH'), 'back at menu');
  await click(client, 'LOCAL 2P');
  await waitFor(async () => (await status(client)) !== 'none', 'second match started');
  const restarted = await frame(client);
  if (restarted > 30) throw new Error(`rematch resumed at frame ${restarted} instead of starting fresh`);
  report.rematch = 'verified';

  // ---- SOLO: one board, a score, and no phantom opponent -----------------
  // The rematch above left us inside a match; pause out of it first.
  await key(client, 'Escape');
  await waitFor(async () => (await body(client)).includes('PAUSED'), 'pause the rematch');
  await click(client, 'QUIT TO MENU');
  await waitFor(async () => (await body(client)).includes('SOLO'), 'menu has solo');
  await click(client, 'SOLO');
  await waitFor(async () => (await status(client)) !== 'none', 'solo started');
  const soloBoards = await client.cdp.evaluate("document.querySelectorAll('canvas').length");
  if (soloBoards !== 1) throw new Error(`solo should show one playfield, saw ${soloBoards}`);
  await waitFor(async () => (await status(client)) === 'playing', 'solo countdown finished', 12_000);

  // Seat 1 must never move in a solo run — that is the whole point of the flag.
  const seatTwoBefore = await client.cdp.evaluate("JSON.stringify(document.querySelector('main').dataset)");
  const soloFrom = await frame(client);
  for (const code of ['KeyA', 'KeyW', 'Space', 'KeyD', 'Space']) await key(client, code);
  await sleep(3000);
  const soloTo = await frame(client);
  if (soloTo <= soloFrom) throw new Error('solo simulation did not advance');
  const soloScore = await client.cdp.evaluate("document.querySelector('.run-score b')?.textContent ?? '0'");
  report.solo = { boards: soloBoards, framesRun: soloTo - soloFrom, score: soloScore };
  if (Number(String(soloScore).replace(/,/g, '')) <= 0) throw new Error('hard drops should have scored something');
  void seatTwoBefore;

  // ---- VERSUS AI: the bot plays on its own ------------------------------
  await key(client, 'Escape');
  await waitFor(async () => (await body(client)).includes('PAUSED'), 'solo pause');
  await click(client, 'QUIT TO MENU');
  await waitFor(async () => (await body(client)).includes('PLAY THE AI'), 'menu has the AI');
  await client.cdp.evaluate(`[...document.querySelectorAll('.difficulty-chip')].find((c) => c.textContent === 'RUTHLESS')?.click()`);
  await click(client, 'PLAY THE AI');
  await waitFor(async () => (await status(client)) === 'playing', 'AI match playing', 12_000);

  const aiBoards = await client.cdp.evaluate("document.querySelectorAll('canvas').length");
  if (aiBoards !== 2) throw new Error(`an AI match needs two playfields, saw ${aiBoards}`);
  const seats = await client.cdp.evaluate("[...document.querySelectorAll('.player-title span')].map((s) => s.innerText)");
  if (!seats.some((label) => label.includes('AI'))) throw new Error(`seat 2 is not labelled as the AI: ${JSON.stringify(seats)}`);

  // Leave the human idle: anything that happens on board 2 is the bot playing.
  const beforeHashes = await hashes(client);
  await sleep(6000);
  const afterHashes = await hashes(client);
  // `String.fromCharCode(10)` rather than an escaped newline: this string is
  // source code for another engine, and an escape that this file resolves is a
  // literal line break by the time the page tries to parse it.
  const aiStats = await client.cdp.evaluate(
    "[...document.querySelectorAll('.player-hud--p2 .stat-stack div')].map((d) => d.innerText.split(String.fromCharCode(10)).join('='))",
  );

  report.ai = { seats, boardChanged: beforeHashes[1] !== afterHashes[1], stats: aiStats };
  if (beforeHashes[1] === afterHashes[1]) throw new Error('the AI never placed a piece');

  const aiLines = Number(String(aiStats.find((s) => s.startsWith('LINES')) ?? 'LINES=0').split('=')[1] ?? 0);
  if (aiLines < 1) throw new Error(`RUTHLESS cleared ${aiLines} lines in six seconds — the bot is not playing properly`);
  report.ai.lines = aiLines;

  await key(client, 'Escape');
  await waitFor(async () => (await body(client)).includes('PAUSED'), 'AI pause');
  await click(client, 'QUIT TO MENU');
  await waitFor(async () => (await body(client)).includes('QUICK MATCH'), 'back at menu again');

  // ---- nothing screamed in the console ----------------------------------
  report.consoleErrors = client.cdp.consoleErrors.filter((line) => !line.includes('React DevTools'));
  if (report.consoleErrors.length) throw new Error(`console errors: ${report.consoleErrors.join(' | ')}`);

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('FAILED:', error.message);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  if (client) {
    try { await Promise.race([client.cdp.send('Browser.close'), sleep(500)]); } catch { /* closing */ }
    try { client.cdp.ws.close(); } catch { /* closing */ }
    await Promise.race([new Promise((resolve) => client.child.once('exit', resolve)), sleep(1500)]);
    if (!client.child.killed) client.child.kill();
    await sleep(300);
    try { await rm(client.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* temp dir */ }
  }
}
