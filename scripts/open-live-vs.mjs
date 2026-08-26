import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const chrome = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const appUrl = process.env.TETRISVS_URL ?? 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    return new Promise((resolveSend, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
}

async function waitFor(check, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function launch(name, port, x) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((candidate) => candidate.type === 'page' && candidate.url !== 'about:blank');
    if (target) {
      const cdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.open();
      await cdp.send('Runtime.enable');
      return { cdp, pid: null };
    }
  } catch {}
  const profile = resolve(`.live-${name}`);
  const child = spawn(chrome, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', `--window-position=${x},40`,
    '--window-size=980,820', '--new-window', appUrl,
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  let target;
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    target = targets.find((candidate) => candidate.type === 'page' && candidate.url !== 'about:blank');
    return Boolean(target);
  }, `${name} browser`);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && document.body.innerText.includes('QUICK MATCH')"), `${name} menu`);
  return { cdp, pid: child.pid };
}

async function clickQuick(client) {
  const point = await client.cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('QUICK MATCH'));
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await client.cdp.send('Page.bringToFront');
  await client.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await client.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function press(client, code, key, virtualKey) {
  await client.cdp.send('Page.bringToFront');
  await client.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  await sleep(80);
  await client.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
}

const first = await launch('player-one', 9421, 20);
const second = await launch('player-two', 9422, 1020);
if (!await first.cdp.evaluate("document.querySelectorAll('canvas').length === 2")) {
  await clickQuick(first);
  await waitFor(() => first.cdp.evaluate("document.body.innerText.includes('SEARCHING')"), 'searching state');
  await clickQuick(second);
}
await Promise.all([first, second].map((client) => waitFor(
  () => client.cdp.evaluate("document.querySelectorAll('canvas').length === 2 && document.querySelector('main')?.dataset.matchStatus === 'playing'"),
  'live match', 15_000,
)));
await sleep(500);
await press(first, 'KeyA', 'a', 65);
await press(first, 'Space', ' ', 32);
await press(second, 'KeyD', 'd', 68);
await press(second, 'Space', ' ', 32);
await sleep(600);
await first.cdp.send('Page.bringToFront');
const image = await first.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
const artifact = resolve('artifacts/live-quick-match.png');
await mkdir(resolve('artifacts'), { recursive: true });
await writeFile(artifact, Buffer.from(image.data, 'base64'));
const room = await first.cdp.evaluate("document.querySelector('.online-ping')?.innerText.replace(/\\s+/g, ' ') ?? ''");
console.log(JSON.stringify({ ok: true, url: appUrl, room, screenshot: artifact, pids: [first.pid, second.pid] }, null, 2));
first.cdp.socket.close();
second.cdp.socket.close();
