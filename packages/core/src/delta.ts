/**
 * Snapshot delta codec.
 *
 * The authoritative server sends the client a snapshot every tick. A full
 * snapshot is ~830 bytes, so at 60 Hz that is ~50 KB/s per client before
 * transport overhead — enough to stall a mobile connection and enough garbage
 * to make the client's GC visible as stutter.
 *
 * Between two consecutive ticks almost nothing in the snapshot changes: the
 * active piece moves a cell, a timer counts down. Byte-wise these buffers are
 * >95% identical, so a run-length diff turns a 830-byte snapshot into a handful
 * of bytes without changing a single semantic: the client reconstructs the
 * *exact* bytes the server serialized, then runs the ordinary `deserialize`.
 *
 * DETERMINISM: pure byte manipulation, no floats, no allocation-order
 * dependence. Encoding the same pair twice always produces identical bytes.
 */

const MAGIC_0 = 0x54; // 'T'
const MAGIC_1 = 0x44; // 'D'
const VERSION = 1;

const FLAG_FULL = 1;

/** Bytes of framing a delta always pays. Used to decide full-vs-delta. */
const HEADER_BYTES = 4;

// ---------------------------------------------------------------- varint

function varintSize(value: number): number {
  let size = 1;
  let v = value >>> 0;
  while (v >= 0x80) {
    v >>>= 7;
    size++;
  }
  return size;
}

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
    if (cursor.offset >= buf.length) throw new Error('snapshot delta truncated');
    const byte = buf[cursor.offset++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
  throw new Error('snapshot delta varint overflow');
}

// ---------------------------------------------------------------- encode

/** Wrap a snapshot as a self-contained "full" frame that needs no baseline. */
export function encodeFullFrame(next: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + next.length);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = VERSION;
  out[3] = FLAG_FULL;
  out.set(next, HEADER_BYTES);
  return out;
}

/**
 * Encode `next` relative to `base`.
 *
 * Falls back to a full frame when there is no baseline or when the diff would
 * not actually be smaller — the receiver never has to know which happened, it
 * just calls `decodeSnapshotFrame`.
 */
export function encodeSnapshotFrame(base: Uint8Array | null, next: Uint8Array): Uint8Array {
  if (!base || base.length === 0) return encodeFullFrame(next);

  const body: number[] = [];
  writeVarint(body, next.length);

  const limit = next.length;
  const shared = Math.min(base.length, limit);
  let index = 0;

  while (index < limit) {
    let same = 0;
    while (index + same < shared && base[index + same] === next[index + same]) same++;
    writeVarint(body, same);
    index += same;
    if (index >= limit) break;

    let diff = 0;
    while (index + diff < limit) {
      const beyondBase = index + diff >= shared;
      if (!beyondBase && base[index + diff] === next[index + diff]) break;
      diff++;
    }
    writeVarint(body, diff);
    for (let i = 0; i < diff; i++) body.push(next[index + i]!);
    index += diff;
  }

  // A diff that is not smaller than the payload is pure overhead; send raw.
  if (body.length >= next.length) return encodeFullFrame(next);

  const out = new Uint8Array(HEADER_BYTES + body.length);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = VERSION;
  out[3] = 0;
  out.set(body, HEADER_BYTES);
  return out;
}

// ---------------------------------------------------------------- decode

/** True when the frame carries a complete snapshot and needs no baseline. */
export function isFullFrame(frame: Uint8Array): boolean {
  return frame.length >= HEADER_BYTES && (frame[3]! & FLAG_FULL) !== 0;
}

/**
 * Rebuild the snapshot bytes a frame describes.
 *
 * Throws on a malformed frame or on a delta with no baseline — callers treat
 * either as "ask the server for a full snapshot" rather than as a fatal error.
 */
export function decodeSnapshotFrame(base: Uint8Array | null, frame: Uint8Array): Uint8Array {
  if (frame.length < HEADER_BYTES) throw new Error('snapshot frame truncated');
  if (frame[0] !== MAGIC_0 || frame[1] !== MAGIC_1) throw new Error('snapshot frame bad magic');
  if (frame[2] !== VERSION) throw new Error(`snapshot frame version ${frame[2]} unsupported`);

  if ((frame[3]! & FLAG_FULL) !== 0) return frame.slice(HEADER_BYTES);
  if (!base || base.length === 0) throw new Error('snapshot delta needs a baseline');

  const cursor: Cursor = { offset: HEADER_BYTES };
  const length = readVarint(frame, cursor);
  if (length > 1 << 22) throw new Error('snapshot delta length implausible');

  const out = new Uint8Array(length);
  const shared = Math.min(base.length, length);
  let index = 0;

  while (index < length) {
    const same = readVarint(frame, cursor);
    if (same > 0) {
      if (index + same > shared) throw new Error('snapshot delta copy out of range');
      out.set(base.subarray(index, index + same), index);
      index += same;
    }
    if (index >= length) break;

    const diff = readVarint(frame, cursor);
    if (diff === 0) throw new Error('snapshot delta made no progress');
    if (index + diff > length) throw new Error('snapshot delta literal out of range');
    if (cursor.offset + diff > frame.length) throw new Error('snapshot delta truncated');
    out.set(frame.subarray(cursor.offset, cursor.offset + diff), index);
    cursor.offset += diff;
    index += diff;
  }

  return out;
}

/** Encoded size a full frame would occupy — used by tests and telemetry. */
export function fullFrameSize(snapshotLength: number): number {
  return HEADER_BYTES + snapshotLength;
}

/** Exported for tests: how many bytes a varint of this value costs. */
export const _varintSize = varintSize;
