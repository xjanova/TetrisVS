/**
 * Replay codec.
 *
 * The simulation is deterministic, so a match is fully described by its seed
 * and the inputs fed to it — there is nothing to record frame by frame. Replay
 * a stored input log through `step()` and you get the original match back, cell
 * for cell, down to the final `hash()`.
 *
 * Raw inputs are 4 bytes a tick (two 8-bit masks per player), so a three-minute
 * match is ~43 kB. Almost every tick repeats the previous one, so a run-length
 * pass over those words collapses it to a few kB.
 *
 * PURE: no I/O, no Date, no Math.random. Encoding the same inputs twice always
 * produces identical bytes.
 */

import type { ActionName, Inputs, PlayerInput } from './types.js';

const MAGIC_0 = 0x54; // 'T'
const MAGIC_1 = 0x52; // 'R'
const VERSION = 1;
const HEADER_BYTES = 3;

/**
 * Bit order for the action masks. **Append only** — reordering this silently
 * reinterprets every replay already on disk.
 */
export const REPLAY_ACTIONS: readonly ActionName[] = [
  'left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold',
] as const;

const BIT_OF = new Map<ActionName, number>(REPLAY_ACTIONS.map((action, index) => [action, 1 << index]));

/** Longest replay we will decode, as a guard against a corrupt length field. */
const MAX_TICKS = 60 * 60 * 60; // one hour of simulation

// ---------------------------------------------------------------- varint

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

interface Cursor {
  offset: number;
}

function readVarint(buf: Uint8Array, cursor: Cursor): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (cursor.offset >= buf.length) throw new Error('replay truncated');
    const byte = buf[cursor.offset++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
  throw new Error('replay varint overflow');
}

// ---------------------------------------------------------------- masks

export function maskOf(actions: readonly ActionName[]): number {
  let mask = 0;
  for (const action of actions) mask |= BIT_OF.get(action) ?? 0;
  return mask & 0xff;
}

export function actionsOf(mask: number): ActionName[] {
  const out: ActionName[] = [];
  for (let index = 0; index < REPLAY_ACTIONS.length; index++) {
    if (mask & (1 << index)) out.push(REPLAY_ACTIONS[index]!);
  }
  return out;
}

/** Pack one tick's inputs for both players into a single 32-bit word. */
export function packTick(inputs: Inputs): number {
  const word =
    maskOf(inputs[0].pressed) |
    (maskOf(inputs[0].held) << 8) |
    (maskOf(inputs[1].pressed) << 16) |
    (maskOf(inputs[1].held) << 24);
  return word >>> 0;
}

export function unpackTick(word: number, frame: number): Inputs {
  const build = (pressedShift: number, heldShift: number): PlayerInput => ({
    frame,
    pressed: actionsOf((word >>> pressedShift) & 0xff),
    held: actionsOf((word >>> heldShift) & 0xff),
  });
  return [build(0, 8), build(16, 24)];
}

// ---------------------------------------------------------------- codec

/**
 * Encode a tick-by-tick input log.
 *
 * `words[i]` is the packed input for tick `i` — build it with `packTick` as the
 * match runs so nothing has to be buffered as objects.
 */
export function encodeReplay(words: readonly number[]): Uint8Array {
  const body: number[] = [];
  writeVarint(body, words.length);

  let index = 0;
  while (index < words.length) {
    const word = words[index]! >>> 0;
    let run = 1;
    while (index + run < words.length && (words[index + run]! >>> 0) === word) run++;
    writeVarint(body, word);
    writeVarint(body, run);
    index += run;
  }

  const out = new Uint8Array(HEADER_BYTES + body.length);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = VERSION;
  out.set(body, HEADER_BYTES);
  return out;
}

/** Decode back to packed words. Throws on anything malformed. */
export function decodeReplay(buf: Uint8Array): number[] {
  if (buf.length < HEADER_BYTES) throw new Error('replay truncated');
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) throw new Error('replay bad magic');
  if (buf[2] !== VERSION) throw new Error(`replay version ${buf[2]} unsupported`);

  const cursor: Cursor = { offset: HEADER_BYTES };
  const ticks = readVarint(buf, cursor);
  if (ticks > MAX_TICKS) throw new Error('replay length implausible');

  const words: number[] = new Array(ticks);
  let index = 0;
  while (index < ticks) {
    const word = readVarint(buf, cursor);
    const run = readVarint(buf, cursor);
    if (run === 0) throw new Error('replay made no progress');
    if (index + run > ticks) throw new Error('replay run overruns tick count');
    words.fill(word >>> 0, index, index + run);
    index += run;
  }
  if (cursor.offset !== buf.length) throw new Error('replay has trailing bytes');
  return words;
}

/** Turn a decoded replay into the `Inputs` sequence `stepMany` expects. */
export function replayInputs(words: readonly number[]): Inputs[] {
  const out: Inputs[] = new Array(words.length);
  for (let frame = 0; frame < words.length; frame++) out[frame] = unpackTick(words[frame]!, frame);
  return out;
}

/**
 * Accumulates packed ticks while a match runs.
 *
 * Deliberately just an array of numbers: recording a tick costs one `push`, so
 * it can sit inside the authoritative loop without adding measurable work.
 */
export class ReplayRecorder {
  private readonly words: number[] = [];

  record(inputs: Inputs): void {
    this.words.push(packTick(inputs));
  }

  get ticks(): number {
    return this.words.length;
  }

  /** Packed words so far — do not mutate. */
  snapshot(): readonly number[] {
    return this.words;
  }

  encode(): Uint8Array {
    return encodeReplay(this.words);
  }

  reset(): void {
    this.words.length = 0;
  }
}
