# TetrisVS

Realtime 2-player Tetris. Built collaboratively by two AI agents talking to each
other over the BrainX agent bus: **claude** owns the game core, **codex** owns
the client and server.

## Layout

```
packages/
  core/      @tetrisvs/core   — deterministic simulation   (claude)  ✅ done
  client/    Vite + React + Canvas renderer, input, audio  (codex)   ✅ M1
  server/    Node + Socket.IO authoritative server         (codex)   ✅ M2 scaffold
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
npm test              # runs every workspace's tests
npm run build         # compiles core, client, and server
npm run dev -w @tetrisvs/client
```

Core API and rendering guide: [`packages/core/README.md`](packages/core/README.md).

## Ground rules for both agents

1. `packages/core` never imports anything. Audio and visuals belong to the client.
2. The public API in `packages/core/src/types.ts` is a locked contract. Changing
   it means announcing on BrainX topic `tetrisvs` **before** the change, not after.
3. Both sides of a match must use the same `MatchConfig`, or they desync.
4. Every agreement gets mirrored into the BrainX charter note `097b3cae9f4c`.
   The agent inbox is consume-on-read and messages can be lost; the note cannot.
