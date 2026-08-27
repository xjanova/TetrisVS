import { useCallback, useEffect, useRef, useState } from 'react';
import {
  leaderboard as fetchLeaderboard,
  login as apiLogin,
  logout as apiLogout,
  me as fetchMe,
  register as apiRegister,
  type LeaderboardRow,
  type Player,
} from '../game/account';

interface AccountPanelProps {
  token: string | null;
  player: Player | null;
  onSignedIn: (token: string, player: Player) => void;
  onSignedOut: () => void;
  onPlayerRefreshed: (player: Player) => void;
}

type Mode = 'login' | 'register';

/**
 * Sign-in and the top ten, on the menu screen.
 *
 * Signing in is optional on purpose: a guest can play every mode, their match
 * is still recorded, it simply earns nobody a rating. Nothing here blocks the
 * game if the server is unreachable — the panel just says so.
 */
export function AccountPanel({ token, player, onSignedIn, onSignedOut, onPlayerRefreshed }: AccountPanelProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [board, setBoard] = useState<LeaderboardRow[] | null>(null);
  const [offline, setOffline] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Refresh the board on mount; it is public, so no token is involved.
  useEffect(() => {
    let cancelled = false;
    fetchLeaderboard(10)
      .then((result) => {
        if (cancelled || !mounted.current) return;
        setOffline(false);
        setBoard(result.status === 200 ? result.body.leaderboard : []);
      })
      .catch(() => {
        if (!cancelled && mounted.current) setOffline(true);
      });
    return () => {
      cancelled = true;
    };
  }, [player]);

  // A stored token can be stale — expired, or revoked by a ban. Check it once.
  useEffect(() => {
    if (!token || player) return;
    let cancelled = false;
    fetchMe(token)
      .then((result) => {
        if (cancelled || !mounted.current) return;
        if (result.status === 200) onPlayerRefreshed(result.body.player);
        else onSignedOut();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onPlayerRefreshed, onSignedOut, player, token]);

  const submit = useCallback(async () => {
    const name = username.trim();
    if (!name || !password) {
      setError('Enter a name and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = mode === 'login' ? await apiLogin(name, password) : await apiRegister(name, password);
      if (!mounted.current) return;
      if (result.status === 200 || result.status === 201) {
        setPassword('');
        setUsername('');
        onSignedIn(result.body.token, result.body.player);
      } else {
        setError(result.body.error ?? 'That did not work.');
      }
    } catch {
      if (mounted.current) setError('Cannot reach the server.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [mode, onSignedIn, password, username]);

  const signOut = useCallback(() => {
    if (token) void apiLogout(token).catch(() => undefined);
    onSignedOut();
  }, [onSignedOut, token]);

  return (
    <div className="account-card">
      {player ? (
        <div className="account-signed-in">
          <div className="account-head">
            <div>
              <div className="eyebrow">SIGNED IN</div>
              <strong className="account-name">{player.username}</strong>
            </div>
            <div className="account-rating">
              <span>RATING</span>
              <b>{player.rating}</b>
            </div>
          </div>
          <div className="account-stats">
            <div><span>W</span><b>{player.wins}</b></div>
            <div><span>L</span><b>{player.losses}</b></div>
            <div><span>D</span><b>{player.draws}</b></div>
            <div><span>LINES</span><b>{player.lines}</b></div>
            <div><span>BEST ATK</span><b>{player.bestAttack}</b></div>
          </div>
          <button className="text-button" onClick={signOut}>SIGN OUT</button>
        </div>
      ) : (
        <div className="account-form">
          <div className="account-tabs">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>SIGN IN</button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>CREATE</button>
          </div>
          <input
            aria-label="Username"
            placeholder="NAME"
            value={username}
            maxLength={20}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setUsername(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
          />
          <input
            aria-label="Password"
            placeholder="PASSWORD"
            type="password"
            value={password}
            maxLength={200}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
          />
          <button className="online-button" disabled={busy} onClick={() => void submit()}>
            {busy ? 'WORKING…' : mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}
          </button>
          {error && <div className="online-error">{error}</div>}
          <p className="account-hint">Optional — you can play as a guest. Signing in keeps your rating.</p>
        </div>
      )}

      <div className="leaderboard">
        <div className="hud-label">TOP PLAYERS</div>
        {offline && <div className="account-hint">Leaderboard unavailable — server offline.</div>}
        {!offline && board === null && <div className="account-hint">Loading…</div>}
        {!offline && board !== null && board.length === 0 && <div className="account-hint">Nobody has finished a match yet.</div>}
        {board !== null && board.length > 0 && (
          <ol className="leaderboard-list">
            {board.map((row) => (
              <li key={row.id} className={player && row.id === player.id ? 'is-you' : ''}>
                <span className="rank">{row.rank}</span>
                <span className="who">{row.username}</span>
                <span className="rating">{row.rating}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
