import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreEvent, MatchConfig, MatchState, PlayerId } from '@tetrisvs/core';
import { createMatch, DEFAULT_CONFIG, levelAt, step, TICK_HZ } from '@tetrisvs/core';
import { Bot, DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from '@tetrisvs/bot';
import { AccountPanel } from './components/AccountPanel';
import { BoardCanvas } from './components/BoardCanvas';
import { PlayerHud } from './components/PlayerHud';
import { loadToken, saveToken, status as fetchStatus, type Player, type ServerStatus } from './game/account';
import { applyScore, emptyScore, formatScore, loadBest, saveBest, type RunScore } from './game/score';
import { ChipAudio } from './game/audio';
import { LocalInput } from './game/input';
import { connectOnline, SnapshotStream, type EndReason, type OnlineSocket } from './game/online';

type Scene = 'menu' | 'room' | 'match' | 'results';
type MatchMode = 'local' | 'online' | 'ai' | 'solo';
type RoomStatus =
  | 'idle' | 'connecting' | 'searching' | 'waiting' | 'matched'
  | 'connected' | 'reconnecting' | 'disconnected';

interface EventBatch {
  id: number;
  events: CoreEvent[];
}

const CONTROL_ROWS = [
  ['MOVE', 'A / D', '← / →'],
  ['SOFT DROP', 'S', '↓'],
  ['ROTATE', 'W / Q', '↑ / ,'],
  ['ROTATE 180', 'E', '.'],
  ['HARD DROP', 'SPACE', 'ENTER'],
  ['HOLD', 'C', '/'],
];

const TICK_MS = 1000 / TICK_HZ;
/** Longest frame the local loop will integrate — the rest is dropped, not owed. */
const MAX_FRAME_MS = 100;
/** Simulation steps one animation frame may run before we give the browser back control. */
const MAX_STEPS_PER_FRAME = 8;
/** Resend held state at least this often online, so a lost packet self-heals. */
const INPUT_HEARTBEAT_TICKS = 20;
/** Delay between a match ending and the result card, so the last effects land. */
const RESULT_DELAY_MS = 800;

/** Seat 1 is not simulated in a solo run; see `MatchConfig.solo`. */
const SOLO_CONFIG: MatchConfig = { ...DEFAULT_CONFIG, solo: true };

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  rookie: 'ROOKIE',
  steady: 'STEADY',
  sharp: 'SHARP',
  ruthless: 'RUTHLESS',
};

const DIFFICULTY_BLURB: Record<Difficulty, string> = {
  rookie: 'Slow hands, frequent mistakes. Tops out on its own.',
  steady: 'Keeps a clean stack. Beatable with pressure.',
  sharp: 'Fast and rarely wrong.',
  ruthless: 'A key every frame, no mistakes. Good luck.',
};

const DIFFICULTY_KEY = 'tetrisvs.difficulty';

function loadDifficulty(): Difficulty {
  try {
    const stored = window.localStorage.getItem(DIFFICULTY_KEY);
    if (stored && (DIFFICULTY_ORDER as readonly string[]).includes(stored)) return stored as Difficulty;
  } catch {
    /* private mode */
  }
  return 'steady';
}

function idleFor(frame: number) {
  return { frame, pressed: [], held: [] };
}

function makeSeed() {
  const data = new Uint32Array(1);
  crypto.getRandomValues(data);
  return data[0]! | 0;
}

export function App() {
  const [scene, setScene] = useState<Scene>('menu');
  const [mode, setMode] = useState<MatchMode>('local');
  const [match, setMatch] = useState<MatchState | null>(null);
  const [batch, setBatch] = useState<EventBatch>({ id: 0, events: [] });
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(3);
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [onlineRole, setOnlineRole] = useState<PlayerId | null>(null);
  const [roomStatus, setRoomStatus] = useState<RoomStatus>('idle');
  const [onlineError, setOnlineError] = useState('');
  const [endReason, setEndReason] = useState<EndReason>('topout');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(() => loadToken());
  const [account, setAccount] = useState<Player | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kicked, setKicked] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>(() => loadDifficulty());
  const [runScore, setRunScore] = useState<RunScore>(() => emptyScore());
  const [best, setBest] = useState(() => loadBest());
  const [newRecord, setNewRecord] = useState(false);
  /** The socket handshake reads this, so it must not lag behind React state. */
  const tokenRef = useRef<string | null>(token);
  /** Synchronous mirror of `busy` — React state lands too late to stop a double-click. */
  const busyRef = useRef(false);

  const stateRef = useRef<MatchState | null>(null);
  const pausedRef = useRef(false);
  const input = useMemo(() => new LocalInput(), []);
  const audio = useMemo(() => new ChipAudio(), []);
  const stream = useMemo(() => new SnapshotStream(), []);
  /** Plays seat 1 in an AI match. Reset between matches so no plan carries over. */
  const bot = useMemo(() => new Bot(1, DIFFICULTIES.steady), []);
  /**
   * The config the loop steps with. Solo needs `solo: true`, and passing the
   * wrong one silently changes the rules — so it is read from a ref the loop
   * owns rather than recomputed from `mode` inside the closure.
   */
  const configRef = useRef<MatchConfig>(DEFAULT_CONFIG);
  const scoreRef = useRef<RunScore>(emptyScore());
  const modeRef = useRef<MatchMode>('local');
  const resultTimer = useRef(0);
  const socketRef = useRef<OnlineSocket | null>(null);
  /**
   * Bumped by every connect attempt. An async continuation that finds its
   * generation stale simply returns — double-clicking QUICK MATCH used to leave
   * a second live socket behind, still emitting into a room nobody was in.
   */
  const generation = useRef(0);

  const signIn = useCallback((next: string, player: Player) => {
    tokenRef.current = next;
    saveToken(next);
    setToken(next);
    setAccount(player);
  }, []);

  const signOut = useCallback(() => {
    tokenRef.current = null;
    saveToken(null);
    setToken(null);
    setAccount(null);
  }, []);

  const clearResultTimer = useCallback(() => {
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    resultTimer.current = 0;
  }, []);

  const scheduleResults = useCallback(() => {
    if (resultTimer.current) return;
    resultTimer.current = window.setTimeout(() => {
      resultTimer.current = 0;
      setScene('results');
    }, RESULT_DELAY_MS);
  }, []);

  const disconnectOnline = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    stream.reset();
    if (!socket) return;
    socket.removeAllListeners();
    socket.disconnect();
  }, [stream]);

  const returnToMenu = useCallback(() => {
    generation.current++;
    clearResultTimer();
    audio.stopMusic();
    input.clear();
    disconnectOnline();
    stateRef.current = null;
    setMatch(null);
    setScene('menu');
    setPaused(false);
    busyRef.current = false;
    setBusy(false);
    setRoomStatus('idle');
    setOnlineRole(null);
    setOnlineError('');
  }, [audio, clearResultTimer, disconnectOnline, input]);

  /**
   * Start anything that runs entirely in this tab: local 2P, versus the AI, or
   * a solo run. They share a loop and differ only in who fills seat 1.
   */
  const startOfflineMatch = useCallback(async (next: Exclude<MatchMode, 'online'>) => {
    generation.current++;
    clearResultTimer();
    disconnectOnline();
    // Audio is a nice-to-have: a blocked or missing AudioContext must not stop
    // the match from starting.
    await audio.unlock();
    audio.startMusic();

    const config = next === 'solo' ? SOLO_CONFIG : DEFAULT_CONFIG;
    configRef.current = config;
    modeRef.current = next;
    if (next === 'ai') {
      bot.setDifficulty(difficulty);
    } else {
      bot.reset();
    }

    const initial = createMatch(makeSeed(), config);
    stateRef.current = initial;
    scoreRef.current = emptyScore();
    setRunScore(scoreRef.current);
    setNewRecord(false);
    setMatch(initial);
    setBatch({ id: 0, events: [] });
    setCountdown(3);
    setPaused(false);
    setEndReason('topout');
    setRoomStatus('idle');
    setOnlineError('');
    setMode(next);
    setScene('match');
  }, [audio, bot, clearResultTimer, difficulty, disconnectOnline]);

  const chooseDifficulty = useCallback((next: Difficulty) => {
    setDifficulty(next);
    try {
      window.localStorage.setItem(DIFFICULTY_KEY, next);
    } catch {
      /* private mode */
    }
  }, []);

  const applyEvents = useCallback((events: CoreEvent[]) => {
    if (!events.length) return;
    audio.events(events);
    setBatch((previous) => ({ id: previous.id + 1, events }));
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.t === 'countdown') {
        setCountdown(event.value > 0 ? event.value : null);
        break;
      }
    }
  }, [audio]);

  const prepareOnlineSocket = useCallback(async (): Promise<{ socket: OnlineSocket; token: number } | null> => {
    const token = ++generation.current;
    clearResultTimer();
    disconnectOnline();
    await audio.unlock();
    if (generation.current !== token) return null;

    setMode('online');
    setOnlineError('');
    setRoomStatus('connecting');
    setScene('room');
    setMatch(null);
    setBatch({ id: 0, events: [] });
    setCountdown(3);
    setEndReason('topout');
    stateRef.current = null;

    // Guests are welcome; a token just attributes the match to an account.
    const socket = connectOnline(tokenRef.current);
    socketRef.current = socket;

    const live = () => generation.current === token && socketRef.current === socket;

    socket.on('connect_error', (error) => {
      if (!live()) return;
      setOnlineError(`Server connection failed: ${error.message}`);
      setRoomStatus('idle');
      busyRef.current = false;
      setBusy(false);
    });
    socket.io.on('reconnect_attempt', () => {
      if (live()) setRoomStatus((current) => (current === 'connected' ? 'reconnecting' : current));
    });
    socket.on('disconnect', (reason) => {
      if (!live()) return;
      stream.reset();
      // An intentional close is not a network problem worth alarming about.
      if (reason === 'io client disconnect') return;
      setRoomStatus((current) => (current === 'disconnected' ? current : 'reconnecting'));
    });
    socket.on('connect', () => {
      if (live()) socket.emit('match:resync');
    });
    socket.on('matchmaking:searching', () => {
      if (live()) setRoomStatus('searching');
    });
    socket.on('matchmaking:matched', ({ roomCode: code, playerId }) => {
      if (!live()) return;
      setRoomCode(code);
      setOnlineRole(playerId);
      setRoomStatus('matched');
    });
    socket.on('room:ready', (code) => {
      if (!live()) return;
      setRoomCode(code);
      setRoomStatus('connected');
      setCountdown(3);
      busyRef.current = false;
      setBusy(false);
      audio.startMusic();
      setScene('match');
    });
    socket.on('match:update', (update) => {
      if (!live()) return;
      const state = stream.apply(update);
      if (!state) {
        // Undecodable frame: keep rendering the last good state and ask for a
        // full snapshot rather than tearing the match down.
        socket.emit('match:resync');
        return;
      }
      stateRef.current = state;
      setMatch(state);
      applyEvents(update.events);
      if (state.status === 'finished') scheduleResults();
    });
    socket.on('match:ended', (_winner, reason) => {
      if (!live()) return;
      setEndReason(reason);
      // A forfeit keeps the "PLAYER LEFT" card up — it is the one that offers a
      // requeue — instead of flashing a result the player did not earn.
      if (reason === 'topout') scheduleResults();
    });
    socket.on('peer:disconnected', () => {
      if (!live()) return;
      clearResultTimer();
      setRoomStatus('disconnected');
    });
    socket.on('server:notice', (message) => {
      if (live()) setNotice(message);
    });
    socket.on('server:kicked', (reason) => {
      if (!live()) return;
      setKicked(reason);
      // A suspended account's stored token is dead; do not keep offering it.
      if (/suspend/i.test(reason)) signOut();
    });

    return { socket, token };
  }, [applyEvents, audio, clearResultTimer, disconnectOnline, scheduleResults, signOut, stream]);

  /** Wrap an async flow so a rejection surfaces in the UI instead of vanishing. */
  const run = useCallback((label: string, flow: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    flow()
      .catch((error: unknown) => {
        console.error(`[tetrisvs] ${label} failed:`, error);
        setOnlineError(error instanceof Error ? error.message : `${label} failed.`);
        setRoomStatus('idle');
        setScene('menu');
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, []);

  const createOnlineRoom = useCallback(() => run('room:create', async () => {
    const session = await prepareOnlineSocket();
    if (!session) return;
    session.socket.emit('room:create', ({ roomCode: code, playerId }) => {
      if (generation.current !== session.token) return;
      if (!code) {
        setOnlineError('The server is at capacity. Try again in a moment.');
        setRoomStatus('idle');
        setScene('menu');
        return;
      }
      setRoomCode(code);
      setOnlineRole(playerId);
      setRoomStatus('waiting');
    });
  }), [prepareOnlineSocket, run]);

  const startQuickMatch = useCallback(() => run('matchmaking:join', async () => {
    const session = await prepareOnlineSocket();
    if (!session) return;
    session.socket.emit('matchmaking:join', 'v1-default', ({ searching }) => {
      if (generation.current !== session.token) return;
      if (searching) setRoomStatus('searching');
    });
  }), [prepareOnlineSocket, run]);

  const cancelQuickMatch = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.connected) socket.emit('matchmaking:cancel', () => returnToMenu());
    else returnToMenu();
    // Do not wait on the server to leave the screen — an ack that never arrives
    // must not strand the player on a cancelled search.
    window.setTimeout(() => setScene((current) => (current === 'room' ? 'menu' : current)), 1500);
  }, [returnToMenu]);

  const joinOnlineRoom = useCallback(() => {
    const code = joinCode.trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(code)) {
      setOnlineError('Enter the 6-character room code.');
      return;
    }
    run('room:join', async () => {
      const session = await prepareOnlineSocket();
      if (!session) return;
      session.socket.emit('room:join', code, (result) => {
        if (generation.current !== session.token) return;
        if (!result.ok || result.playerId === undefined) {
          setOnlineError(result.reason ?? 'Unable to join room.');
          setRoomStatus('idle');
          setScene('menu');
          return;
        }
        setRoomCode(code);
        setOnlineRole(result.playerId);
        setRoomStatus('waiting');
      });
    });
  }, [joinCode, prepareOnlineSocket, run]);

  // ---------------------------------------------------------------- lifecycle

  useEffect(() => {
    if (scene !== 'match') return;
    input.attach();
    return () => input.detach();
  }, [input, scene]);

  /**
   * A socket only exists once a player starts an online flow, so an operator
   * notice would otherwise never reach anyone sitting on the menu. Poll for it
   * there instead — the endpoint is public and carries no personal data.
   */
  useEffect(() => {
    if (scene !== 'menu') return;
    let cancelled = false;
    const poll = () => {
      fetchStatus()
        .then((result) => {
          if (cancelled) return;
          if (result.status === 200) {
            setServerStatus(result.body);
            setNotice(result.body.notice);
          } else setServerStatus(null);
        })
        .catch(() => {
          if (!cancelled) setServerStatus(null);
        });
    };
    poll();
    const timer = window.setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scene]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    audio.setMuted(muted);
  }, [audio, muted]);

  /** Tear everything down on unmount — timers, sockets, and the AudioContext. */
  useEffect(() => () => {
    clearResultTimer();
    disconnectOnline();
    input.detach();
    audio.dispose();
  }, [audio, clearResultTimer, disconnectOnline, input]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Escape' || scene !== 'match' || mode === 'online') return;
      event.preventDefault();
      setPaused((value) => !value);
      input.clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [input, mode, scene]);

  /**
   * Leaving the tab during a local match pauses it. Online is authoritative and
   * keeps running, so there we only drop held keys (the input layer does that)
   * rather than pretending we can stop the clock.
   */
  useEffect(() => {
    if (scene !== 'match' || mode !== 'local') return;
    const suspend = () => {
      if (document.visibilityState === 'hidden') {
        input.clear();
        setPaused(true);
      }
    };
    const onBlur = () => {
      input.clear();
      setPaused(true);
    };
    document.addEventListener('visibilitychange', suspend);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', suspend);
      window.removeEventListener('blur', onBlur);
    };
  }, [input, mode, scene]);

  // ---------------------------------------------------------------- game loop

  useEffect(() => {
    if (scene !== 'match') return;
    let raf = 0;
    let previous = performance.now();
    let accumulator = 0;
    let sinceSend = INPUT_HEARTBEAT_TICKS;
    let lastSignature = '';

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, now - previous));
      previous = now;

      if (mode === 'online') {
        // Send at the simulation rate rather than the display rate: a 144 Hz
        // monitor used to push 144 messages a second per player at the server.
        accumulator = Math.min(accumulator + elapsed, TICK_MS * 4);
        if (accumulator < TICK_MS) return;
        accumulator -= TICK_MS;

        const state = stateRef.current;
        const socket = socketRef.current;
        if (!state || !socket?.connected || state.status === 'finished') return;

        const payload = input.consumeMerged(state.frame);
        const signature = LocalInput.signature(payload);
        sinceSend++;
        if (payload.pressed.length || signature !== lastSignature || sinceSend >= INPUT_HEARTBEAT_TICKS) {
          socket.emit('match:input', payload);
          lastSignature = signature;
          sinceSend = 0;
        }
        return;
      }

      if (pausedRef.current) {
        // Drop the backlog instead of banking it — resuming must not fast-forward.
        accumulator = 0;
        return;
      }

      accumulator += elapsed;
      let iterations = 0;
      const collected: CoreEvent[] = [];
      const config = configRef.current;
      const offlineMode = modeRef.current;

      while (accumulator >= TICK_MS && iterations < MAX_STEPS_PER_FRAME && stateRef.current) {
        const current = stateRef.current;
        let inputs;
        if (offlineMode === 'local') {
          // Two people, one keyboard: each control scheme drives its own seat.
          inputs = input.consume(current.frame);
        } else {
          // One person: either scheme drives seat 0, and seat 1 is the bot (or
          // nobody at all, in a solo run).
          const human = input.consumeMerged(current.frame);
          inputs = [human, offlineMode === 'ai' ? bot.think(current) : idleFor(current.frame)] as const;
        }
        const result = step(current, inputs as Parameters<typeof step>[1], config);
        stateRef.current = result.state;
        if (result.events.length) collected.push(...result.events);
        accumulator -= TICK_MS;
        iterations++;
      }
      // Anything still owed after the cap is time we can never catch up on.
      if (accumulator > TICK_MS) accumulator = 0;

      if (iterations && stateRef.current) setMatch(stateRef.current);
      if (collected.length && stateRef.current) {
        const scored = applyScore(scoreRef.current, collected, 0, levelAt(stateRef.current.frame, config));
        if (scored !== scoreRef.current) {
          scoreRef.current = scored;
          setRunScore(scored);
        }
      }
      applyEvents(collected);
      if (stateRef.current?.status === 'finished') scheduleResults();
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [applyEvents, bot, input, mode, scene, scheduleResults]);

  /**
   * Record a solo run once it is over. Deliberately local-only: the server
   * cannot verify a match played entirely in this tab, so submitting it to the
   * rating leaderboard would just be a spoofable endpoint.
   */
  useEffect(() => {
    if (scene !== 'results' || modeRef.current !== 'solo' || !match) return;
    const run = { score: scoreRef.current.score, lines: scoreRef.current.lines, frames: match.frame, at: Date.now() };
    if (run.score <= 0) return;
    if (saveBest(run)) {
      setNewRecord(true);
      setBest(run);
    }
  }, [match, scene]);

  // ---------------------------------------------------------------- render

  const [eventsP1, eventsP2] = useMemo(() => {
    const one: CoreEvent[] = [];
    const two: CoreEvent[] = [];
    for (const event of batch.events) {
      if (!('p' in event)) {
        one.push(event);
        two.push(event);
      } else if (event.p === 0) one.push(event);
      else two.push(event);
    }
    return [one, two] as const;
  }, [batch]);

  const online = mode === 'online';

  const seatOneLabel = online
    ? (onlineRole === 0 ? `YOU · ${account?.username ?? 'WASD'}` : 'OPPONENT')
    : mode === 'local' ? 'WASD'
    : account?.username ?? 'YOU';

  const seatTwoLabel = online
    ? (onlineRole === 1 ? `YOU · ${account?.username ?? 'WASD'}` : 'OPPONENT')
    : mode === 'ai' ? `AI · ${DIFFICULTY_LABEL[difficulty]}`
    : 'ARROWS';

  return (
    <main className={`app scene-${scene}`} data-match-status={match?.status ?? 'none'} data-frame={match?.frame ?? 0}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      {notice && <div className="server-notice" role="status">{notice}</div>}
      {kicked && (
        <div className="modal-backdrop">
          <div className="pause-card">
            <div className="eyebrow">DISCONNECTED BY THE SERVER</div>
            <h2>REMOVED</h2>
            <p className="disconnect-copy">{kicked}</p>
            <button className="primary-button" onClick={() => { setKicked(null); returnToMenu(); }}>BACK TO MENU</button>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="mini-logo"><span>TETRIS</span><b>VS</b></div>
        <button className="icon-button" onClick={() => setMuted((value) => !value)} aria-label="Toggle sound">
          {muted ? 'SOUND OFF' : 'SOUND ON'}
        </button>
      </header>

      {scene === 'menu' && (
        <section className="menu-screen">
          <div className="eyebrow">REALTIME BLOCK BATTLE // TWO PLAYERS</div>
          <h1 aria-label="Tetris VS"><span>TETRIS</span><em>VS</em></h1>
          <p className="tagline">Stack fast. Send garbage. Own the grid.</p>
          <div className="mode-actions">
            <button className="primary-button" disabled={busy} onClick={startQuickMatch}><span>QUICK MATCH</span><i>VS</i></button>
            <button className="online-button local-button" disabled={busy} onClick={() => run('solo', () => startOfflineMatch('solo'))}>SOLO · PLAY ALONE</button>

            <div className="private-label">VERSUS THE MACHINE</div>
            <div className="difficulty-row">
              {DIFFICULTY_ORDER.map((level) => (
                <button
                  key={level}
                  className={`difficulty-chip ${difficulty === level ? 'active' : ''}`}
                  onClick={() => chooseDifficulty(level)}
                  aria-pressed={difficulty === level}
                >
                  {DIFFICULTY_LABEL[level]}
                </button>
              ))}
            </div>
            <p className="difficulty-blurb">{DIFFICULTY_BLURB[difficulty]}</p>
            <button className="online-button" disabled={busy} onClick={() => run('ai', () => startOfflineMatch('ai'))}>PLAY THE AI</button>

            <div className="private-label">TWO PLAYERS, ONE KEYBOARD</div>
            <button className="online-button local-button" disabled={busy} onClick={() => run('local', () => startOfflineMatch('local'))}>LOCAL 2P</button>
            <div className="private-label">PRIVATE ROOM</div>
            <button className="online-button" disabled={busy} onClick={createOnlineRoom}>CREATE WITH CODE</button>
            <div className="join-row">
              <input
                aria-label="Room code"
                value={joinCode}
                maxLength={6}
                placeholder="ROOM CODE"
                onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-F0-9]/g, ''))}
                onKeyDown={(event) => { if (event.key === 'Enter') joinOnlineRoom(); }}
              />
              <button disabled={busy} onClick={joinOnlineRoom}>JOIN</button>
            </div>
            {onlineError && <div className="online-error">{onlineError}</div>}
          </div>
          <AccountPanel
            token={token}
            player={account}
            onSignedIn={signIn}
            onSignedOut={signOut}
            onPlayerRefreshed={setAccount}
          />
          <div className="control-card">
            <div className="control-head"><span>ACTION</span><b>PLAYER 1</b><b>PLAYER 2</b></div>
            {CONTROL_ROWS.map(([action, p1, p2]) => (
              <div className="control-row" key={action}><span>{action}</span><kbd>{p1}</kbd><kbd>{p2}</kbd></div>
            ))}
          </div>
          <div className={`future-note ${serverStatus ? 'online-ready' : 'online-down'}`}>
            <i />
            {serverStatus
              ? serverStatus.maintenance
                ? 'SERVER IN MAINTENANCE // LOCAL PLAY ONLY'
                : `ONLINE // ${serverStatus.playersOnline} CONNECTED · ${serverStatus.activeMatches} IN PLAY`
              : 'SERVER OFFLINE // LOCAL PLAY ONLY'}
          </div>
        </section>
      )}

      {scene === 'room' && (
        <section className="room-screen">
          <div className="room-card">
            <div className="eyebrow">ONLINE ROOM</div>
            <h2>{roomStatus === 'connecting' ? 'CONNECTING' : roomStatus === 'searching' ? 'SEARCHING' : roomStatus === 'matched' ? 'MATCHED' : roomCode || 'JOINING'}</h2>
            {roomStatus === 'searching' && <p>Looking for the oldest compatible opponent. You will be paired automatically.</p>}
            {roomStatus === 'matched' && <p>Opponent found. Starting authoritative match…</p>}
            {roomStatus === 'waiting' && onlineRole === 0 && <p>Share this code with Player 2. The match starts automatically when they join.</p>}
            {roomStatus === 'waiting' && onlineRole === 1 && <p>Joined. Waiting for the authoritative match stream…</p>}
            {roomStatus === 'connecting' && <p>Contacting the TetrisVS server…</p>}
            {roomStatus === 'reconnecting' && <p>Connection dropped. Retrying…</p>}
            {onlineError && <div className="online-error">{onlineError}</div>}
            <div className="connection-light"><i className={roomStatus} />{roomStatus.toUpperCase()}</div>
            <button className="text-button" onClick={roomStatus === 'searching' ? cancelQuickMatch : returnToMenu}>{roomStatus === 'searching' ? 'CANCEL SEARCH' : 'CANCEL'}</button>
          </div>
        </section>
      )}

      {match && (scene === 'match' || scene === 'results') && (
        <section className={`battle-screen ${mode === 'solo' ? 'battle-screen--solo' : ''}`}>
          <div className="player-zone player-zone--one">
            <div className="player-title"><small>PLAYER</small><strong>01</strong><span>{seatOneLabel}</span></div>
            <PlayerHud state={match} playerId={0} />
            <div className="board-shell"><BoardCanvas player={match.players[0]} events={eventsP1} eventId={batch.id} /></div>
          </div>
          <div className="versus-column">
            <div className="vs-mark">VS</div>
            <div className="frame-counter">FRAME {String(match.frame).padStart(6, '0')}</div>
            {(mode === 'solo' || mode === 'ai') && (
              <div className="run-score">
                <span>SCORE</span>
                <b>{formatScore(runScore.score)}</b>
                {best && <i>BEST {formatScore(best.score)}</i>}
              </div>
            )}
            {online
              ? <div className="online-ping">ONLINE<br />{roomCode}</div>
              : <button className="pause-button" onClick={() => setPaused((value) => !value)}>{paused ? 'RESUME' : 'PAUSE'}</button>}
          </div>
          {mode !== 'solo' && (
            <div className="player-zone player-zone--two">
              <div className="player-title"><small>PLAYER</small><strong>02</strong><span>{seatTwoLabel}</span></div>
              <div className="board-shell"><BoardCanvas player={match.players[1]} events={eventsP2} eventId={batch.id} /></div>
              <PlayerHud state={match} playerId={1} />
            </div>
          )}

          {countdown !== null && match.status === 'countdown' && <div className="countdown" key={countdown}>{countdown}</div>}
          {online && roomStatus === 'reconnecting' && scene === 'match' && (
            <div className="net-banner">RECONNECTING…</div>
          )}
          {paused && scene === 'match' && (
            <div className="modal-backdrop">
              <div className="pause-card"><div className="eyebrow">MATCH SUSPENDED</div><h2>PAUSED</h2><button className="primary-button" onClick={() => setPaused(false)}>RESUME</button><button className="text-button" onClick={returnToMenu}>QUIT TO MENU</button></div>
            </div>
          )}
          {roomStatus === 'disconnected' && scene === 'match' && (
            <div className="modal-backdrop">
              <div className="pause-card">
                <div className="eyebrow">CONNECTION LOST</div>
                <h2>PLAYER LEFT</h2>
                <p className="disconnect-copy">The opponent disconnected from room {roomCode}. The match is yours by forfeit.</p>
                <button className="primary-button" disabled={busy} onClick={startQuickMatch}>QUICK MATCH AGAIN</button>
                <button className="text-button" onClick={returnToMenu}>BACK TO MENU</button>
              </div>
            </div>
          )}
          {scene === 'results' && (
            <div className="modal-backdrop result-backdrop">
              <div className="result-card">
                <div className="eyebrow">
                  {mode === 'solo' ? 'RUN OVER'
                    : endReason === 'forfeit' ? 'OPPONENT LEFT'
                    : 'BATTLE COMPLETE'}
                </div>
                <h2>
                  {mode === 'solo' ? (newRecord ? 'NEW RECORD' : 'TOPPED OUT')
                    : mode === 'ai' ? (match.winner === 0 ? 'YOU WIN' : match.winner === 1 ? `${DIFFICULTY_LABEL[difficulty]} WINS` : 'DRAW GAME')
                    : match.winner === null ? 'DRAW GAME'
                    : `PLAYER ${match.winner + 1} WINS`}
                </h2>

                {mode === 'solo' || mode === 'ai' ? (
                  <div className="result-run">
                    <div><span>SCORE</span><b>{formatScore(runScore.score)}</b></div>
                    <div><span>LINES</span><b>{runScore.lines}</b></div>
                    <div><span>BEST COMBO</span><b>{runScore.bestCombo}</b></div>
                    <div><span>TETRIS</span><b>{runScore.tetrises}</b></div>
                    {runScore.tSpins > 0 && <div><span>T-SPIN</span><b>{runScore.tSpins}</b></div>}
                    {best && mode === 'solo' && <div><span>PERSONAL BEST</span><b>{formatScore(best.score)}</b></div>}
                  </div>
                ) : (
                  <div className="result-score">
                    <span>P1 <b>{match.players[0].attackSent}</b> ATK</span>
                    <i>—</i>
                    <span>P2 <b>{match.players[1].attackSent}</b> ATK</span>
                  </div>
                )}

                {mode === 'solo' && <p className="account-hint">Solo runs stay on this device — the server cannot verify a match played offline, so they do not touch the rating leaderboard.</p>}

                {online
                  ? <button className="primary-button" disabled={busy} onClick={startQuickMatch}>QUICK MATCH AGAIN</button>
                  : <button className="primary-button" disabled={busy} onClick={() => run(mode, () => startOfflineMatch(mode as Exclude<MatchMode, 'online'>))}>
                      {mode === 'solo' ? 'RUN AGAIN' : 'REMATCH'}
                    </button>}
                <button className="text-button" onClick={returnToMenu}>BACK TO MENU</button>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
