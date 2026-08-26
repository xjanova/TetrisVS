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
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
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

async function launchClient(name, port) {
  const profile = await mkdtemp(join(tmpdir(), `tetrisvs-${name}-`));
  const process = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', APP_URL,
  ], { stdio: 'ignore', windowsHide: true });
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === 'page' && item.url !== 'about:blank');
  }, `${name} Chrome target`);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && document.body.innerText.includes('QUICK MATCH')"), `${name} app`);
  return { name, cdp, process, profile };
}

async function closeClient(client) {
  if (!client) return;
  try { await Promise.race([client.cdp.send('Browser.close'), sleep(500)]); } catch {}
  try { client.cdp.ws.close(); } catch {}
  await Promise.race([
    new Promise((resolve) => client.process.once('exit', resolve)),
    sleep(1_000),
  ]);
  if (!client.process.killed) client.process.kill();
  await sleep(300);
  try { await rm(client.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
}

const body = (client) => client.cdp.evaluate('document.body.innerText');
const click = async (client, label) => {
  const point = await client.cdp.evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(${JSON.stringify(label)}));
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`);
  if (!point) return false;
  await client.cdp.send('Page.bringToFront');
  await client.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return true;
};
const key = async (client, code, keyValue) => {
  const virtualKey = code === 'Space' ? 32 : code.startsWith('Key') ? code.charCodeAt(3) : 0;
  await client.cdp.send('Page.bringToFront');
  await client.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: keyValue, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  await sleep(80);
  await client.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyValue, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
};
const boardHashes = (client) => client.cdp.evaluate("[...document.querySelectorAll('canvas')].map((canvas) => canvas.dataset.boardHash)");

let first;
let second;
let replacement;
try {
  first = await launchClient('first', 9321);
  second = await launchClient('second', 9322);

  if (!await click(first, 'QUICK MATCH')) throw new Error('First Quick Match button missing');
  await waitFor(async () => (await body(first)).includes('SEARCHING'), 'first client searching');
  if (!await click(first, 'CANCEL SEARCH')) throw new Error('Cancel Search button missing');
  await waitFor(async () => (await body(first)).includes('LOCAL 2P'), 'cancel returns to menu');

  await click(first, 'QUICK MATCH');
  await waitFor(async () => (await body(first)).includes('SEARCHING'), 'first client requeued');
  await click(second, 'QUICK MATCH');
  await waitFor(async () => {
    if (await first.cdp.evaluate("document.querySelectorAll('canvas').length === 2")) return true;
    throw new Error(JSON.stringify({ first: await body(first), second: await body(second) }));
  }, 'first client matched');
  await waitFor(() => second.cdp.evaluate("document.querySelectorAll('canvas').length === 2"), 'second client matched');
  const rooms = await Promise.all([first, second].map((client) => client.cdp.evaluate("document.querySelector('.online-ping')?.innerText ?? ''")));
  if (!rooms[0] || rooms[0] !== rooms[1]) throw new Error(`Room synchronization failed: ${rooms.join(' / ')}`);
  const roles = await Promise.all([first, second].map((client) => client.cdp.evaluate("[...document.querySelectorAll('.player-title span')].map((item) => item.innerText)")));
  if (!roles[0].some((value) => value.includes('YOU')) || !roles[1].some((value) => value.includes('YOU'))) throw new Error('Distinct player roles not rendered');

  await waitFor(() => first.cdp.evaluate("document.querySelector('main')?.dataset.matchStatus === 'playing'"), 'initial match playing', 8_000);
  await sleep(500);
  await Promise.all([first, second].map((client) => client.cdp.evaluate("window.__tetrisKeyLog = []; window.addEventListener('keydown', (event) => window.__tetrisKeyLog.push(event.code)); true")));
  await key(first, 'KeyA', 'a');
  await key(first, 'Space', ' ');
  await key(second, 'KeyD', 'd');
  await key(second, 'Space', ' ');
  const synchronized = await waitFor(async () => {
    const [firstView, secondView] = await Promise.all([boardHashes(first), boardHashes(second)]);
    if (firstView.length === 2 && firstView[0] === secondView[0] && firstView[1] === secondView[1]
      && firstView[0] !== firstView[1]) return { firstView, secondView };
    const [firstKeys, secondKeys, frame] = await Promise.all([
      first.cdp.evaluate('window.__tetrisKeyLog'), second.cdp.evaluate('window.__tetrisKeyLog'), first.cdp.evaluate("document.querySelector('main')?.dataset.frame"),
    ]);
    throw new Error(JSON.stringify({ firstView, secondView, firstKeys, secondKeys, frame }));
  }, 'authoritative distinct board synchronization');
  const { firstView, secondView } = synchronized;
  if (firstView[0] === firstView[1]) throw new Error('Distinct inputs did not produce distinct board states');

  await closeClient(second);
  second = null;
  await waitFor(async () => (await body(first)).includes('PLAYER LEFT'), 'disconnect notification');
  await click(first, 'QUICK MATCH AGAIN');
  await waitFor(async () => (await body(first)).includes('SEARCHING'), 'survivor requeued');

  replacement = await launchClient('replacement', 9323);
  await click(replacement, 'QUICK MATCH');
  await waitFor(() => first.cdp.evaluate("document.querySelectorAll('canvas').length === 2"), 'survivor rematched');
  await waitFor(() => replacement.cdp.evaluate("document.querySelectorAll('canvas').length === 2"), 'replacement matched');
  const rematchRooms = await Promise.all([first, replacement].map((client) => client.cdp.evaluate("document.querySelector('.online-ping')?.innerText ?? ''")));
  if (!rematchRooms[0] || rematchRooms[0] !== rematchRooms[1]) throw new Error('Requeue room synchronization failed');

  await waitFor(() => first.cdp.evaluate("document.querySelector('main')?.dataset.matchStatus === 'playing'"), 'rematch playing', 8_000);
  await sleep(500);
  for (let index = 0; index < 40; index++) {
    await key(first, 'Space', ' ');
    if ((await body(first)).includes('WINS')) break;
    await sleep(100);
  }
  const result = await waitFor(async () => {
    const [a, b] = await Promise.all([body(first), body(replacement)]);
    const aWin = a.match(/PLAYER [12] WINS/)?.[0];
    const bWin = b.match(/PLAYER [12] WINS/)?.[0];
    return aWin && aWin === bWin ? aWin : false;
  }, 'shared match result', 10_000);

  console.log(JSON.stringify({
    ok: true,
    cancellation: 'verified',
    initialRoom: rooms[0].replace(/\s+/g, ' '),
    roles,
    synchronizedDistinctBoards: firstView,
    disconnect: 'verified',
    requeueRoom: rematchRooms[0].replace(/\s+/g, ' '),
    result,
  }, null, 2));
} finally {
  await Promise.all([closeClient(first), closeClient(second), closeClient(replacement)]);
}
