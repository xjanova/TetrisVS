# TetrisVS

Realtime 2-player Tetris. Built collaboratively by two AI agents talking to each
other over the BrainX agent bus: **claude** owns the game core, **codex** owns
the client and server.

## Layout

```
packages/
  core/      @tetrisvs/core   — deterministic simulation, replay + delta codecs
  store/     @tetrisvs/store  — SQLite persistence: accounts, matches, replays
  client/    Vite + React + Canvas renderer, input, audio
  server/    Node + Socket.IO authoritative server + HTTP API
```

## Stack

- TypeScript everywhere
- Client: Vite + React (UI shell) + HTML5 Canvas (playfield)
- Server: Node.js + Socket.IO, **authoritative** — it runs the same
  `@tetrisvs/core` simulation as the client and verifies it
- Tests: Vitest, headless

## Milestones

| | scope |
|---|---|
| **M1** | local 2 players, one screen, one machine. Proves the rules are right. |
| **M2** | online across the internet: room codes, input sync, reconnect, garbage relayed through the server |
| **M3** | polish — visual effects, synthesized 16-bit audio |

M1 ships first, but the architecture targets M2 from day one. That is why the
core is deterministic before anything is drawn on screen: nothing has to be
rewritten to go online.

## Why the core is a separate package

The server is authoritative, so it must run *the same simulation as the client* —
otherwise "authoritative" is a word rather than a property. `@tetrisvs/core`
therefore imports nothing at all: no DOM, no canvas, no React, no socket, no
audio, no Node built-ins. It runs unchanged in a browser and in Node.

## Getting started

```bash
npm install
npm run verify        # build (core first) + every workspace's tests
npm run dev           # client on http://127.0.0.1:5173
npm run server        # authoritative server on :3001
```

`npm run build` builds **core before client and server** on purpose: plain
`--workspaces` visits them alphabetically, so the client used to compile against
a stale `@tetrisvs/core` and fail on anything newly exported.

### Verifying it end to end

```bash
npm run e2e:local     # local 2P in a real browser: tick rate, pause, blur, rematch
npm run e2e:online    # two browsers, matchmaking, disconnect, requeue, result
npm run smoke:abuse   # hostile payloads at the sockets AND the HTTP API
npm run smoke:store   # accounts, a real match, the leaderboard, replay fidelity
```

The browser harnesses need `npm run dev` up; `smoke:abuse` needs `npm run server`
(`smoke:store` starts its own throwaway server). Set `CHROME_PATH` if Chrome is
not at the Windows default.

## Persistence

The server keeps its data in SQLite, in-process — no daemon, no credentials, no
network hop between a match ending and the row landing.

```bash
TETRISVS_DB=./data/tetrisvs.db   # default
TETRISVS_TRUST_PROXY=1           # only behind a proxy you control
```

| endpoint | |
|---|---|
| `POST /api/register` `POST /api/login` | `{username, password}` → bearer token |
| `POST /api/logout` · `GET /api/me` | bearer token |
| `GET /api/leaderboard` · `/api/matches` · `/api/matches/:id` | public |
| `GET /api/matches/:id/replay` | the input log, as bytes |
| `GET /api/players/:name` · `GET /api/stats` | public; `/api/stats` is aggregate only |
| `GET /health` | includes write-queue depth |

Pass the token as `auth: { token }` in the Socket.IO handshake and matches are
attributed to the account. Without one you play as a guest: the match is still
recorded, it just earns nobody a rating.

**Replays are the seed plus the input log** — the simulation is deterministic,
so that is a complete recording. A three-minute match is a couple of kB, and
`smoke:store` asserts that a downloaded replay hashes identically to the state
the client saw over the wire.

## Stability notes

Things that are load-bearing and easy to undo by accident:

- **The wire is delta-compressed.** `match:update.snapshot` is a *frame*, not a
  snapshot: a full one at the start, then a byte-diff against the previous frame
  that socket received. That is ~26 B/tick instead of ~1.2 kB, and it is why the
  server keeps a per-socket baseline. A client that cannot decode a frame emits
  `match:resync` and keeps rendering its last good state.
- **Everything from a socket is hostile.** `packages/server/src/guards.ts` owns
  the validation; every handler is wrapped so a throw costs one socket rather
  than the process. `npm run smoke:abuse` is the regression test.
- **The server runs a fixed timestep with an accumulator**, not
  `setInterval(1000/60)` — that form is truncated to 16 ms and silently drops
  every tick the event loop is late for.
- **`gravityAt(frame)` is pure.** Difficulty ramps off the frame counter alone,
  so nothing extra has to be synchronised or stored in the snapshot.
- **The renderer caches its art.** Backdrop, grid, and per-colour block sprites
  are baked into offscreen canvases; effect decay integrates real elapsed time
  so a 144 Hz monitor does not play everything 2.4x too fast.
- **The database is never touched from the tick path.** `better-sqlite3` is
  synchronous, and this process runs a 60 Hz simulation in the same event loop.
  Match results go through `store.recordMatch()`, which only appends to an
  in-memory queue; a separate timer writes the batch. `/health` reports the
  queue depth and the slowest flush.
- **Passwords are scrypt, hashed asynchronously.** `scryptSync` would spend
  ~90 ms blocking the loop — six dropped game ticks per login. Sessions are
  stored as a SHA-256 digest, never as the token itself.
- **Nothing from a socket or a request body is trusted.** Usernames pass a
  whitelist, every statement binds its parameters, bodies are capped at 4 kB,
  and both `smoke:abuse` and the store's own suite fire the payloads that
  matter (injection, prototype pollution, oversized arrays) at them.

Core API and rendering guide: [`packages/core/README.md`](packages/core/README.md).

## Ground rules for both agents

1. `packages/core` never imports anything. Audio and visuals belong to the client.
2. The public API in `packages/core/src/types.ts` is a locked contract. Changing
   it means announcing on BrainX topic `tetrisvs` **before** the change, not after.
3. Both sides of a match must use the same `MatchConfig`, or they desync.
4. Every agreement gets mirrored into the BrainX charter note `097b3cae9f4c`.
   The agent inbox is consume-on-read and messages can be lost; the note cannot.
