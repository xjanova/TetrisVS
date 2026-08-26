import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreEvent, MatchState, PlayerId } from '@tetrisvs/core';
import { createMatch, deserialize, step, TICK_HZ } from '@tetrisvs/core';
import { BoardCanvas } from './components/BoardCanvas';
import { PlayerHud } from './components/PlayerHud';
import { ChipAudio } from './game/audio';
import { LocalInput } from './game/input';
import { connectOnline, snapshotBytes, type OnlineSocket } from './game/online';

type Scene = 'menu' | 'room' | 'match' | 'results';
type MatchMode = 'local' | 'online';
type RoomStatus = 'idle' | 'connecting' | 'searching' | 'waiting' | 'matched' | 'connected' | 'disconnected';

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

function makeSeed() {
  const data = new Uint32Array(1);
  crypto.getRandomValues(data);
  return data[0] | 0;
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
  const stateRef = useRef<MatchState | null>(null);
  const pausedRef = useRef(false);
  const input = useMemo(() => new LocalInput(), []);
  const audio = useMemo(() => new ChipAudio(), []);
  const resultTimer = useRef(0);
  const socketRef = useRef<OnlineSocket | null>(null);

  const disconnectOnline = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
  }, []);

  const returnToMenu = useCallback(() => {
    window.clearTimeout(resultTimer.current);
    audio.stopMusic();
    input.clear();
    disconnectOnline();
    stateRef.current = null;
    setMatch(null);
    setScene('menu');
    setPaused(false);
    setRoomStatus('idle');
    setOnlineRole(null);
    setOnlineError('');
  }, [audio, disconnectOnline, input]);

  const startLocalMatch = useCallback(async () => {
    window.clearTimeout(resultTimer.current);
    resultTimer.current = 0;
    await audio.unlock();
    audio.startMusic();
    const initial = createMatch(makeSeed());
    stateRef.current = initial;
    setMatch(initial);
    setBatch({ id: 0, events: [] });
    setCountdown(3);
    setPaused(false);
    setMode('local');
    setScene('match');
  }, [audio]);

  const consumeOnlineUpdate = useCallback((state: MatchState, events: CoreEvent[]) => {
    stateRef.current = state;
    setMatch(state);
    if (events.length) {
      audio.events(events);
      setBatch((previousBatch) => ({ id: previousBatch.id + 1, events }));
      const cue = [...events].reverse().find((event) => event.t === 'countdown');
      if (cue?.t === 'countdown') setCountdown(cue.value > 0 ? cue.value : null);
    }
    if (state.status === 'finished' && !resultTimer.current) {
      resultTimer.current = window.setTimeout(() => setScene('results'), 800);
    }
  }, [audio]);

  const prepareOnlineSocket = useCallback(async () => {
    window.clearTimeout(resultTimer.current);
    resultTimer.current = 0;
    await audio.unlock();
    disconnectOnline();
    setMode('online');
    setOnlineError('');
    setRoomStatus('connecting');
    setScene('room');
    setMatch(null);
    setBatch({ id: 0, events: [] });
    setCountdown(3);
    stateRef.current = null;
    const socket = connectOnline();
    socketRef.current = socket;
    socket.on('connect_error', (error) => {
      setOnlineError(`Server connection failed: ${error.message}`);
      setRoomStatus('idle');
    });
    socket.on('matchmaking:searching', () => setRoomStatus('searching'));
    socket.on('matchmaking:matched', ({ roomCode: code, playerId }) => {
      setRoomCode(code);
      setOnlineRole(playerId);
      setRoomStatus('matched');
    });
    socket.on('room:ready', (code) => {
      setRoomCode(code);
      setRoomStatus('connected');
      setCountdown(3);
      audio.startMusic();
      setScene('match');
    });
    socket.on('match:update', ({ events, snapshot }) => {
      consumeOnlineUpdate(deserialize(snapshotBytes(snapshot)), events);
    });
    socket.on('peer:disconnected', () => setRoomStatus('disconnected'));
    return socket;
  }, [audio, consumeOnlineUpdate, disconnectOnline]);

  const createOnlineRoom = useCallback(async () => {
    const socket = await prepareOnlineSocket();
    socket.emit('room:create', ({ roomCode: code, playerId }) => {
      setRoomCode(code);
      setOnlineRole(playerId);
      setRoomStatus('waiting');
    });
  }, [prepareOnlineSocket]);

  const startQuickMatch = useCallback(async () => {
    const socket = await prepareOnlineSocket();
    socket.emit('matchmaking:join', 'v1-default', ({ searching }) => {
      if (searching) setRoomStatus('searching');
    });
  }, [prepareOnlineSocket]);

  const cancelQuickMatch = useCallback(() => {
    const socket = socketRef.current;
    if (socket) socket.emit('matchmaking:cancel', () => returnToMenu());
    else returnToMenu();
  }, [returnToMenu]);

  const joinOnlineRoom = useCallback(async () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6) {
      setOnlineError('Enter the 6-character room code.');
      return;
    }
    const socket = await prepareOnlineSocket();
    socket.emit('room:join', code, (result) => {
      if (!result.ok || result.playerId === undefined) {
        setOnlineError(result.reason ?? 'Unable to join room.');
        setRoomStatus('idle');
        return;
      }
      setRoomCode(code);
      setOnlineRole(result.playerId);
      setRoomStatus('waiting');
    });
  }, [joinCode, prepareOnlineSocket]);

  useEffect(() => {
    if (scene !== 'match') return;
    input.attach();
    return () => input.detach();
  }, [input, scene]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    audio.setMuted(muted);
  }, [audio, muted]);

  useEffect(() => () => disconnectOnline(), [disconnectOnline]);

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

  useEffect(() => {
    if (scene !== 'match') return;
    let raf = 0;
    let previous = performance.now();
    let accumulator = 0;
    const tickMs = 1000 / TICK_HZ;

    const loop = (now: number) => {
      const elapsed = Math.min(100, now - previous);
      previous = now;
      if (mode === 'online') {
        const state = stateRef.current;
        const socket = socketRef.current;
        if (state && socket?.connected && state.status !== 'finished') {
          const consumed = input.consume(state.frame);
          socket.emit('match:input', {
            frame: state.frame,
            pressed: [...new Set([...consumed[0].pressed, ...consumed[1].pressed])],
            held: [...new Set([...consumed[0].held, ...consumed[1].held])],
          });
        }
        raf = requestAnimationFrame(loop);
        return;
      }
      if (!pausedRef.current) accumulator += elapsed;
      let iterations = 0;
      const collected: CoreEvent[] = [];

      while (accumulator >= tickMs && iterations < 8 && stateRef.current) {
        const result = step(stateRef.current, input.consume(stateRef.current.frame));
        stateRef.current = result.state;
        collected.push(...result.events);
        accumulator -= tickMs;
        iterations++;
      }

      if (iterations && stateRef.current) setMatch(stateRef.current);
      if (collected.length) {
        audio.events(collected);
        setBatch((previousBatch) => ({ id: previousBatch.id + 1, events: collected }));
        const cue = [...collected].reverse().find((event) => event.t === 'countdown');
        if (cue?.t === 'countdown') setCountdown(cue.value > 0 ? cue.value : null);
      }

      if (stateRef.current?.status === 'finished' && !resultTimer.current) {
        resultTimer.current = window.setTimeout(() => setScene('results'), 800);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [audio, input, mode, scene]);

  const eventsFor = (player: PlayerId) => batch.events.filter((event) => !('p' in event) || event.p === player);

  return (
    <main className={`app scene-${scene}`} data-match-status={match?.status ?? 'none'} data-frame={match?.frame ?? 0}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
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
            <button className="primary-button" onClick={startQuickMatch}><span>QUICK MATCH</span><i>VS</i></button>
            <button className="online-button local-button" onClick={startLocalMatch}>LOCAL 2P · SAME KEYBOARD</button>
            <div className="private-label">PRIVATE ROOM</div>
            <button className="online-button" onClick={createOnlineRoom}>CREATE WITH CODE</button>
            <div className="join-row">
              <input
                aria-label="Room code"
                value={joinCode}
                maxLength={6}
                placeholder="ROOM CODE"
                onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-F0-9]/g, ''))}
                onKeyDown={(event) => { if (event.key === 'Enter') void joinOnlineRoom(); }}
              />
              <button onClick={joinOnlineRoom}>JOIN</button>
            </div>
            {onlineError && <div className="online-error">{onlineError}</div>}
          </div>
          <div className="control-card">
            <div className="control-head"><span>ACTION</span><b>PLAYER 1</b><b>PLAYER 2</b></div>
            {CONTROL_ROWS.map(([action, p1, p2]) => (
              <div className="control-row" key={action}><span>{action}</span><kbd>{p1}</kbd><kbd>{p2}</kbd></div>
            ))}
          </div>
          <div className="future-note online-ready"><i />ONLINE MATCHMAKING // LIVE</div>
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
            {onlineError && <div className="online-error">{onlineError}</div>}
            <div className="connection-light"><i className={roomStatus} />{roomStatus.toUpperCase()}</div>
            <button className="text-button" onClick={roomStatus === 'searching' ? cancelQuickMatch : returnToMenu}>{roomStatus === 'searching' ? 'CANCEL SEARCH' : 'CANCEL'}</button>
          </div>
        </section>
      )}

      {match && (scene === 'match' || scene === 'results') && (
        <section className="battle-screen">
          <div className="player-zone player-zone--one">
            <div className="player-title"><small>PLAYER</small><strong>01</strong><span>{mode === 'online' && onlineRole === 0 ? 'YOU · WASD' : 'WASD'}</span></div>
            <PlayerHud state={match} playerId={0} />
            <div className="board-shell"><BoardCanvas player={match.players[0]} events={eventsFor(0)} eventId={batch.id} /></div>
          </div>
          <div className="versus-column">
            <div className="vs-mark">VS</div>
            <div className="frame-counter">FRAME {String(match.frame).padStart(6, '0')}</div>
            {mode === 'local' ? <button className="pause-button" onClick={() => setPaused((value) => !value)}>{paused ? 'RESUME' : 'PAUSE'}</button> : <div className="online-ping">ONLINE<br />{roomCode}</div>}
          </div>
          <div className="player-zone player-zone--two">
            <div className="player-title"><small>PLAYER</small><strong>02</strong><span>{mode === 'online' && onlineRole === 1 ? 'YOU · WASD' : 'ARROWS'}</span></div>
            <div className="board-shell"><BoardCanvas player={match.players[1]} events={eventsFor(1)} eventId={batch.id} /></div>
            <PlayerHud state={match} playerId={1} />
          </div>

          {countdown !== null && match.status === 'countdown' && <div className="countdown" key={countdown}>{countdown}</div>}
          {paused && scene === 'match' && (
            <div className="modal-backdrop">
              <div className="pause-card"><div className="eyebrow">MATCH SUSPENDED</div><h2>PAUSED</h2><button className="primary-button" onClick={() => setPaused(false)}>RESUME</button><button className="text-button" onClick={returnToMenu}>QUIT TO MENU</button></div>
            </div>
          )}
          {roomStatus === 'disconnected' && scene === 'match' && (
            <div className="modal-backdrop">
              <div className="pause-card"><div className="eyebrow">CONNECTION LOST</div><h2>PLAYER LEFT</h2><p className="disconnect-copy">The opponent disconnected from room {roomCode}.</p><button className="primary-button" onClick={startQuickMatch}>QUICK MATCH AGAIN</button><button className="text-button" onClick={returnToMenu}>BACK TO MENU</button></div>
            </div>
          )}
          {scene === 'results' && (
            <div className="modal-backdrop result-backdrop">
              <div className="result-card">
                <div className="eyebrow">BATTLE COMPLETE</div>
                <h2>{match.winner === null ? 'DRAW GAME' : `PLAYER ${match.winner + 1} WINS`}</h2>
                <div className="result-score">
                  <span>P1 <b>{match.players[0].attackSent}</b> ATK</span>
                  <i>—</i>
                  <span>P2 <b>{match.players[1].attackSent}</b> ATK</span>
                </div>
                {mode === 'local' && <button className="primary-button" onClick={startLocalMatch}>REMATCH</button>}
                <button className="text-button" onClick={returnToMenu}>BACK TO MENU</button>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
