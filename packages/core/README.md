# @tetrisvs/core

Deterministic Tetris VS simulation. **Zero dependencies. Zero imports.**
No DOM, no canvas, no React, no socket, no Web Audio, no Node built-ins — so the
same code runs in the browser and on the authoritative server and produces
byte-identical results.

Contract **v1.1**, locked with codex on 2026-08-14 (BrainX charter `097b3cae9f4c`).
Anything exported from `src/types.ts` is a breaking change if altered — announce
on topic `tetrisvs` before touching it.

---

## Install / run

```bash
npm install          # from the repo root — this is an npm workspace
npm test  -w @tetrisvs/core
npm run build -w @tetrisvs/core      # emits dist/ with .d.ts
npm run typecheck -w @tetrisvs/core
```

## The whole API

```ts
import {
  createMatch, step, nextPieces, hash, serialize, deserialize,
} from '@tetrisvs/core';

let state = createMatch(seed);                 // seed is a uint32
const { state: next, events } = step(state, inputs);
```

| function | what it does |
|---|---|
| `createMatch(seed, config?)` | fresh `MatchState` in `countdown` |
| `step(state, inputs, config?)` | advance **exactly one tick**. Pure — never mutates `state` |
| `nextPieces(seed, bagIndex, count)` | upcoming pieces. Pure — derive the preview, never sync it |
| `hash(state)` | uint32 FNV-1a of the snapshot. Desync detection |
| `serialize(state)` / `deserialize(buf)` | ~920-byte snapshot. Reconnect path |

There is **no `dt` parameter**, by design. `dt` is non-determinism: the server
and client would compute different results. Everything is counted in ticks at
`TICK_HZ = 60`.

## Coordinates

- Board is a flat array, row-major, `BOARD_W * BOARD_H_TOTAL` = 10 × 40.
- Index is `y * BOARD_W + x`. **Index 0 is the top-left cell. `y` grows downward.**
- The top 20 rows are the hidden spawn buffer. The bottom 20 are what you draw.
  `visibleRows(board)` hands you exactly those.
- `Cell` is `0` (empty) | `'I'|'J'|'L'|'O'|'S'|'T'|'Z'` (locked piece, use for colour)
  | `'G'` (garbage — render it grey).

The published SRS kick tables are written y-up; ours are negated to y-down.
`test/pieces.test.ts` pins that convention with explicit anchors so a sign flip
cannot slip through.

## Rendering

```ts
import { visibleRows, ghostPosition, nextPieces, NEXT_COUNT } from '@tetrisvs/core';

const p = state.players[playerId];
const rows  = visibleRows(p.board);                        // Cell[20][10]
const ghost = p.active ? ghostPosition(p.board, p.active) : null;
const queue = nextPieces(state.seed, p.bagIndex, NEXT_COUNT);
```

The ghost piece is **not** stored in state — compute it, it is one call.

## Events

`step()` returns every notable thing that happened on that tick, so the
render/audio layer never has to diff state frame by frame:

`countdown` · `spawn` · `move` · `rotate` · `softDrop` · `hardDrop` · `hold` ·
`holdDenied` · `lock` · `lineClear` · `comboUp` · `b2bUp` · `b2bBreak` ·
`attack` · `garbageIncoming` · `garbageCancelled` · `garbageApplied` ·
`topout` · `matchEnd`

Two worth calling out for effects work:

- `rotate` carries `kick` (which SRS attempt succeeded) and `tspin` — flash the
  piece the instant a spin registers, not after the clear.
- `garbageIncoming` carries `readyAtFrame`. You know the exact tick the garbage
  will land, so a telegraph animation can be timed to it rather than guessed.

## Rules implemented

- SRS rotation with full wall-kick tables for I and JLSTZ; O never kicks.
  180° rotation uses our own documented 4-entry table (SRS does not define one).
- 7-bag randomiser. `nextPieces` is a pure function of `(seed, bagIndex)`, so
  the queue is never transmitted and can never desync.
- Lock delay with a reset budget, DAS/ARR, hold with a one-use-per-piece lock.
- T-spin detection: T piece + last action was a rotation + ≥3 corners blocked.
  Full when both front corners are blocked or the last SRS kick (index 4) was
  used; mini otherwise. Rotating *into* the slot scores; dropping in does not.
- Attack table with back-to-back, a combo curve, and a perfect-clear bonus.
- Garbage: outgoing attack cancels your own pending incoming first, the
  remainder is telegraphed to the opponent and only lands on a lock that
  cleared nothing.

All tunable numbers live in `MatchConfig` (`DEFAULT_CONFIG`), separate from the
state shape — they can be retuned without breaking anything you compile against.
**Both sides of a match must use the same config or they will desync.**

## For the authoritative server

```ts
// replay the client's inputs and compare
const mine = step(serverState, clientInputs).state;
if (hash(mine) !== clientReportedHash) {
  socket.emit('resync', serialize(mine));   // ~920 bytes
}
```

`step` being pure is what makes this work: same state + same inputs = same
bytes, every time, on every machine. `test/determinism.test.ts` proves it,
including the reconnect path (snapshot mid-match, resume, land on the same hash
as an uninterrupted run).

## Tests

88 tests across 7 files — `npm test -w @tetrisvs/core`.

| file | covers |
|---|---|
| `rng.test.ts` | bag permutations, purity, bag-boundary crossing |
| `pieces.test.ts` | shape integrity, SRS table invariants, y-down anchors |
| `board.test.ts` | collision, row clearing, garbage insertion, ghost |
| `tspin.test.ts` | corner rules, mini vs full, kick-4 promotion |
| `attack.test.ts` | damage table, B2B, combo curve, perfect clear |
| `match.test.ts` | full tick loop, DAS, hold, clears, garbage, topout, T-spin end to end |
| `determinism.test.ts` | replay equality, no mutation, snapshot round-trip, resync |
