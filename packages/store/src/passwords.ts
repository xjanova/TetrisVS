/**
 * Password hashing.
 *
 * scrypt, from Node's own crypto — no native dependency, no supply chain, and
 * memory-hard so a GPU does not help an attacker much.
 *
 * Three things here are deliberate and easy to undo by accident:
 *
 *   1. **Always async.** Hashing is meant to take ~100 ms. `scryptSync` would
 *      spend that blocking the event loop, which on this process also runs a
 *      60 Hz simulation — one login would drop six game ticks. The async form
 *      runs on the threadpool instead.
 *   2. **Constant-time comparison.** `===` on a hash leaks how many leading
 *      bytes matched through timing.
 *   3. **The parameters travel with the hash.** They can be raised later
 *      without invalidating everyone's password.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/**
 * ~90 ms on a modern desktop core and 32 MiB of memory per hash.
 *
 * The memory figure is the interesting one for a server: `128 * N * r` bytes,
 * so N and r bound how many logins can be in flight before the box swaps.
 */
export const DEFAULT_PARAMS: ScryptParams = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

const SALT_BYTES = 16;
/** Node defaults to a 32 MiB ceiling, which the parameters above sit exactly on. */
const MAXMEM = 96 * 1024 * 1024;

export interface StoredPassword {
  hash: Buffer;
  salt: Buffer;
  params: string;
}

export function serializeParams(params: ScryptParams): string {
  return `scrypt$N=${params.N},r=${params.r},p=${params.p},len=${params.keylen}`;
}

/** Parse a stored parameter string. Returns `null` rather than throwing on junk. */
export function parseParams(encoded: string): ScryptParams | null {
  const match = /^scrypt\$N=(\d+),r=(\d+),p=(\d+),len=(\d+)$/.exec(encoded);
  if (!match) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const keylen = Number(match[4]);
  // Reject anything that would let a crafted row make the server allocate
  // gigabytes or spin for minutes when it verifies.
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  if (!Number.isInteger(keylen) || keylen < 16 || keylen > 128) return null;
  if (128 * N * r > MAXMEM) return null;
  return { N, r, p, keylen };
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (error, derived) => (error ? reject(error) : resolve(derived as Buffer)),
    );
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<StoredPassword> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, params);
  return { hash, salt, params: serializeParams(params) };
}

/**
 * Verify a candidate password. Never throws — a malformed stored row is a
 * failed login, not a 500.
 */
export async function verifyPassword(password: string, stored: StoredPassword): Promise<boolean> {
  const params = parseParams(stored.params);
  if (!params) return false;
  if (stored.hash.length !== params.keylen) return false;
  try {
    const candidate = await derive(password, stored.salt, params);
    return candidate.length === stored.hash.length && timingSafeEqual(candidate, stored.hash);
  } catch {
    return false;
  }
}

const DUMMY_SALT = randomBytes(SALT_BYTES);

/**
 * Burn the same work a real verification would.
 *
 * Without this, "no such user" returns in microseconds while a wrong password
 * takes ~90 ms, and anyone can enumerate valid usernames with a stopwatch.
 */
export async function dummyVerify(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<false> {
  try {
    await derive(password, DUMMY_SALT, params);
  } catch {
    /* the answer is false either way */
  }
  return false;
}

/**
 * True when a stored hash was made with weaker settings than the current
 * default — the caller can transparently re-hash on the next successful login.
 */
export function needsRehash(stored: StoredPassword, params: ScryptParams = DEFAULT_PARAMS): boolean {
  const current = parseParams(stored.params);
  if (!current) return true;
  return current.N < params.N || current.r < params.r || current.keylen < params.keylen;
}
