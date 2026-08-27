/**
 * The operator console, served at `/admin`.
 *
 * One self-contained page: no build step, no bundler, no CDN. That is
 * deliberate — the console has to work when the client build is broken, when
 * npm is unreachable, and when you are on a box with nothing but the server.
 * The CSP the route sets blocks every external fetch, so everything here is
 * inline by necessity as well as by choice.
 *
 * The token lives in sessionStorage, not localStorage: closing the tab ends the
 * operator session on that machine.
 */

export const CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>TetrisVS · Server Console</title>
<style>
  :root {
    --bg: #06070f; --panel: #0d1024; --panel-2: #12162f; --line: #232a52;
    --ink: #e7ebff; --dim: #8b93bd; --accent: #6f7bff; --good: #46e08a;
    --warn: #ffb020; --bad: #ff4f70; --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink); min-height: 100vh;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background-image: radial-gradient(900px 500px at 15% -10%, #1b1f4a55, transparent),
                      radial-gradient(700px 400px at 90% 0%, #4a1f5a44, transparent);
  }
  h1, h2, h3 { margin: 0; font-weight: 800; letter-spacing: -.01em; }
  a { color: var(--accent); }
  code, .mono { font-family: var(--mono); font-size: 12px; }

  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 22px; border-bottom: 1px solid var(--line);
    background: #0a0c1cdd; position: sticky; top: 0; z-index: 10; backdrop-filter: blur(10px);
  }
  .logo { font-weight: 900; letter-spacing: .04em; }
  .logo b { color: var(--accent); }
  .spacer { flex: 1; }
  .pill {
    padding: 4px 11px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--panel); font-size: 12px; color: var(--dim);
  }
  .pill.live { color: var(--good); border-color: #2a5f45; }
  .pill.stale { color: var(--bad); border-color: #5f2a3a; }
  .pill.maint { color: var(--warn); border-color: #5f4a1f; }

  main { padding: 20px; max-width: 1500px; margin: 0 auto; display: grid; gap: 18px; }
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); }
  .wide { grid-column: 1 / -1; }

  .card {
    background: linear-gradient(180deg, var(--panel), var(--panel-2));
    border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; min-width: 0;
  }
  .card > h2 {
    font-size: 12px; letter-spacing: .16em; text-transform: uppercase;
    color: var(--dim); margin-bottom: 12px; display: flex; align-items: center; gap: 8px;
  }
  .card > h2 .count { color: var(--accent); }

  .stats { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
  .stat { background: #0a0d20; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .stat span { display: block; font-size: 10px; letter-spacing: .14em; color: var(--dim); text-transform: uppercase; }
  .stat strong { display: block; font-size: 21px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .stat.ok strong { color: var(--good); }
  .stat.warn strong { color: var(--warn); }
  .stat.bad strong { color: var(--bad); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 0 8px 8px 0; font-weight: 600; }
  td { padding: 7px 8px 7px 0; border-top: 1px solid #1a1f3f; vertical-align: middle; }
  tr.dead td { opacity: .5; }
  .scroll { overflow-x: auto; }
  .empty { color: var(--dim); font-size: 13px; padding: 10px 0; }

  button {
    font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
    padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line);
    background: #171c3a; color: var(--ink); transition: .12s;
  }
  button:hover:not(:disabled) { border-color: var(--accent); transform: translateY(-1px); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #05061a; }
  button.danger { color: #ffc9d4; border-color: #4a2030; background: #2a1220; }
  button.danger:hover:not(:disabled) { border-color: var(--bad); }
  button.tiny { padding: 3px 9px; font-size: 11px; }

  input, select {
    font: inherit; font-size: 13px; padding: 8px 11px; border-radius: 8px;
    border: 1px solid var(--line); background: #080a1a; color: var(--ink); width: 100%;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row > .grow { flex: 1; min-width: 140px; }

  .tag { font-size: 10px; padding: 2px 7px; border-radius: 5px; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
  .tag.owner { background: #3b2a5f; color: #d9c4ff; }
  .tag.admin { background: #1f3f5f; color: #b8dcff; }
  .tag.player { background: #1a1f3f; color: var(--dim); }
  .tag.banned { background: #4a1520; color: #ffc9d4; }
  .tag.playing { background: #12402c; color: #8bf0bb; }
  .tag.countdown { background: #4a3a12; color: #ffd98b; }
  .tag.finished { background: #1a1f3f; color: var(--dim); }

  .gate { max-width: 420px; margin: 60px auto; }
  .gate .card { padding: 26px; }
  .gate h1 { font-size: 26px; margin-bottom: 6px; }
  .gate p { color: var(--dim); margin: 0 0 18px; font-size: 13px; }
  .gate label { display: block; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); margin: 12px 0 5px; }
  .msg { margin-top: 14px; font-size: 13px; padding: 9px 12px; border-radius: 8px; }
  .msg.err { background: #2a1220; color: #ffc9d4; border: 1px solid #4a2030; }
  .msg.ok { background: #10301f; color: #9bf0c0; border: 1px solid #1f5f3a; }
  .hint { color: var(--dim); font-size: 12px; margin-top: 10px; }
  .hidden { display: none !important; }
  .dim { color: var(--dim); }
  .num { font-variant-numeric: tabular-nums; }
  #toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: #171c3a; border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 18px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 50;
  }
  #toast.show { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>

<div id="gate" class="gate hidden">
  <div class="card">
    <h1>TetrisVS <span style="color:var(--accent)">Console</span></h1>
    <p id="gate-sub">Sign in with an operator account.</p>
    <label for="u">Username</label>
    <input id="u" autocomplete="username" autocapitalize="none" spellcheck="false">
    <label for="p">Password</label>
    <input id="p" type="password" autocomplete="current-password">
    <div class="row" style="margin-top:18px">
      <button class="primary grow" id="signin">SIGN IN</button>
      <button class="grow hidden" id="create">CREATE ACCOUNT</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="grow hidden" id="claim">CLAIM OWNER</button>
    </div>
    <div id="gate-msg"></div>
    <p class="hint" id="gate-hint"></p>
  </div>
</div>

<div id="app" class="hidden">
<header>
  <div class="logo">TETRIS<b>VS</b> · CONSOLE</div>
  <span class="pill" id="who"></span>
  <span class="pill" id="link"></span>
  <span class="pill hidden" id="maint-pill">MAINTENANCE</span>
  <div class="spacer"></div>
  <span class="pill" id="uptime"></span>
  <button id="signout">SIGN OUT</button>
</header>

<main>
  <div class="card wide">
    <h2>Live</h2>
    <div class="stats" id="live-stats"></div>
  </div>

  <div class="card wide">
    <h2>Rooms <span class="count" id="room-count"></span></h2>
    <div class="scroll"><table id="rooms"></table></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Controls</h2>
      <div class="row" style="margin-bottom:10px">
        <button id="toggle-maint" class="grow">MAINTENANCE MODE</button>
        <button id="flush" class="grow">FLUSH WRITE QUEUE</button>
      </div>
      <label class="dim" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase">Notice shown to every player</label>
      <div class="row" style="margin-top:6px">
        <input id="notice" class="grow" placeholder="Server restarting in 5 minutes…" maxlength="160">
        <button id="set-notice">SEND</button>
        <button id="clear-notice">CLEAR</button>
      </div>
      <p class="hint">Maintenance mode refuses new matches; matches already running finish normally.</p>
    </div>

    <div class="card">
      <h2>Connections <span class="count" id="conn-count"></span></h2>
      <div class="scroll"><table id="conns"></table></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Players</h2>
      <div class="row" style="margin-bottom:10px">
        <input id="q" class="grow" placeholder="search by name…" maxlength="40">
        <button id="search">SEARCH</button>
      </div>
      <div class="scroll"><table id="players"></table></div>
    </div>

    <div class="card">
      <h2>Recent matches</h2>
      <div class="scroll"><table id="matches"></table></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Leaderboard</h2>
      <div class="scroll"><table id="board"></table></div>
    </div>
    <div class="card">
      <h2>Operator log</h2>
      <div class="scroll"><table id="audit"></table></div>
    </div>
  </div>
</main>
</div>

<div id="toast"></div>

<script>
(function () {
  'use strict';

  var KEY = 'tetrisvs.console.token';
  var token = null;
  try { token = sessionStorage.getItem(KEY); } catch (e) { token = null; }
  var timer = null;
  var lastOk = 0;

  var $ = function (id) { return document.getElementById(id); };

  /** Everything from the server is data. Nothing is ever assigned to innerHTML. */
  function el(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function toast(message) {
    var t = $('toast');
    t.textContent = message;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function api(path, options) {
    options = options || {};
    var headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        return { status: response.status, body: body };
      });
    });
  }

  function ago(ms) {
    if (!ms) return '—';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function duration(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  // ------------------------------------------------------------------ gate

  function showGate(message, isError) {
    $('app').classList.add('hidden');
    $('gate').classList.remove('hidden');
    if (timer) { clearInterval(timer); timer = null; }
    var box = $('gate-msg');
    clear(box);
    if (message) box.appendChild(el('div', 'msg ' + (isError ? 'err' : 'ok'), message));
    api('/api/admin/setup-status').then(function (r) {
      var needs = r.body && r.body.needsSetup;
      $('claim').classList.toggle('hidden', !needs);
      // On a brand-new server nobody has an account yet, so "sign in" alone is
      // a dead end. Registration is already a public route; the claim below is
      // what is actually privileged.
      $('create').classList.toggle('hidden', !needs);
      $('gate-hint').textContent = needs
        ? 'Nobody owns this server yet. Create an account (or sign in with one you already have), then press CLAIM OWNER.'
        : '';
      $('gate-sub').textContent = needs
        ? 'This server has no operator yet.'
        : 'Sign in with an operator account.';
    });
  }

  function signIn() {
    var username = $('u').value.trim();
    var password = $('p').value;
    if (!username || !password) return showGate('Enter a name and password.', true);
    $('signin').disabled = true;
    api('/api/login', { method: 'POST', body: { username: username, password: password } })
      .then(function (r) {
        $('signin').disabled = false;
        if (r.status !== 200 || !r.body.token) return showGate(r.body.error || 'Sign-in failed.', true);
        token = r.body.token;
        try { sessionStorage.setItem(KEY, token); } catch (e) { /* private mode */ }
        $('p').value = '';
        start();
      })
      .catch(function () { $('signin').disabled = false; showGate('Server unreachable.', true); });
  }

  function createAccount() {
    var username = $('u').value.trim();
    var password = $('p').value;
    if (!username || !password) return showGate('Enter a name and a password of at least 8 characters.', true);
    $('create').disabled = true;
    api('/api/register', { method: 'POST', body: { username: username, password: password } })
      .then(function (r) {
        $('create').disabled = false;
        if (r.status !== 201 || !r.body.token) return showGate(r.body.error || 'Could not create that account.', true);
        token = r.body.token;
        try { sessionStorage.setItem(KEY, token); } catch (e) { /* private mode */ }
        $('p').value = '';
        showGate('Account created. Now press CLAIM OWNER.', false);
      })
      .catch(function () { $('create').disabled = false; showGate('Server unreachable.', true); });
  }

  function claimOwner() {
    if (!token) return showGate('Sign in first, then claim.', true);
    api('/api/admin/setup', { method: 'POST', body: {} }).then(function (r) {
      if (r.status === 201) { toast('You are now the owner.'); start(); }
      else showGate(r.body.error || 'Could not claim ownership.', true);
    });
  }

  function signOut() {
    api('/api/logout', { method: 'POST', body: {} }).finally(function () {
      token = null;
      try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      showGate('Signed out.', false);
    });
  }

  // ------------------------------------------------------------------ render

  function stat(label, value, tone) {
    var node = el('div', 'stat' + (tone ? ' ' + tone : ''));
    node.appendChild(el('span', null, label));
    node.appendChild(el('strong', null, value));
    return node;
  }

  function head(table, columns) {
    var tr = el('tr');
    columns.forEach(function (c) { tr.appendChild(el('th', null, c)); });
    var thead = el('thead');
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  function renderLive(data) {
    var server = data.server, queue = data.queue, today = data.today, totals = data.totals;
    var box = $('live-stats');
    clear(box);
    box.appendChild(stat('Rooms', server.rooms.length));
    box.appendChild(stat('Connections', server.connections.length));
    box.appendChild(stat('In queue', server.queuedForMatchmaking));
    box.appendChild(stat('Tick Hz', server.measuredHz.toFixed(1),
      server.measuredHz > 55 ? 'ok' : server.measuredHz > 40 ? 'warn' : 'bad'));
    box.appendChild(stat('Write queue', queue.pending, queue.pending > 50 ? 'warn' : ''));
    box.appendChild(stat('Write fails', queue.failed, queue.failed ? 'bad' : 'ok'));
    box.appendChild(stat('Matches today', today ? today.matches : 0));
    box.appendChild(stat('Matches total', totals.matches));
    box.appendChild(stat('Memory', server.rssMB + ' MB', server.rssMB > 700 ? 'warn' : ''));

    $('uptime').textContent = 'up ' + duration(server.uptimeSeconds) + ' · node ' + server.nodeVersion + ' · pid ' + server.pid;
    $('maint-pill').classList.toggle('hidden', !server.maintenance);
    $('toggle-maint').textContent = server.maintenance ? 'RESUME MATCHMAKING' : 'MAINTENANCE MODE';
    $('toggle-maint').classList.toggle('danger', !server.maintenance);
    if (document.activeElement !== $('notice')) $('notice').value = server.notice || '';
  }

  function renderRooms(rooms) {
    var table = $('rooms');
    clear(table);
    $('room-count').textContent = rooms.length ? '(' + rooms.length + ')' : '';
    if (!rooms.length) { table.appendChild(el('caption', 'empty', 'No rooms right now.')); return; }
    head(table, ['Room', 'State', 'Frame', 'Seat 1', 'Seat 2', 'Age', 'Replay', '']);
    var body = el('tbody');
    rooms.forEach(function (room) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', room.code));
      var st = el('td');
      st.appendChild(el('span', 'tag ' + room.status, room.status));
      tr.appendChild(st);
      tr.appendChild(el('td', 'num', room.frame));
      room.seats.forEach(function (seat) {
        var td = el('td');
        td.appendChild(el('span', seat.connected ? '' : 'dim', seat.name));
        var meta = el('div', 'dim mono', (seat.connected ? '' : 'gone · ') + seat.lines + 'L / ' + seat.attack + 'A'
          + (seat.incoming ? ' / ' + seat.incoming + ' in' : ''));
        td.appendChild(meta);
        tr.appendChild(td);
      });
      tr.appendChild(el('td', 'dim num', duration(room.ageSeconds)));
      tr.appendChild(el('td', 'dim num', room.replayTicks));
      var act = el('td');
      var close = el('button', 'tiny danger', 'CLOSE');
      close.onclick = function () { closeRoom(room.code); };
      close.disabled = room.concluded;
      act.appendChild(close);
      tr.appendChild(act);
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderConns(list) {
    var table = $('conns');
    clear(table);
    $('conn-count').textContent = list.length ? '(' + list.length + ')' : '';
    if (!list.length) { table.appendChild(el('caption', 'empty', 'Nobody connected.')); return; }
    head(table, ['Who', 'Room', 'For', '']);
    var body = el('tbody');
    list.forEach(function (conn) {
      var tr = el('tr');
      var who = el('td');
      who.appendChild(el('span', null, conn.username || 'guest'));
      who.appendChild(el('div', 'dim mono', conn.socketId));
      tr.appendChild(who);
      tr.appendChild(el('td', 'mono', conn.roomCode || '—'));
      tr.appendChild(el('td', 'dim num', duration(conn.connectedForSeconds)));
      var act = el('td');
      var kick = el('button', 'tiny danger', 'KICK');
      kick.onclick = function () { kick_(conn.socketId); };
      act.appendChild(kick);
      tr.appendChild(act);
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderPlayers(list, myRole) {
    var table = $('players');
    clear(table);
    if (!list.length) { table.appendChild(el('caption', 'empty', 'No players yet.')); return; }
    head(table, ['Name', 'Role', 'Rating', 'W/L/D', 'Seen', '']);
    var body = el('tbody');
    list.forEach(function (p) {
      var tr = el('tr', p.bannedAt ? 'dead' : '');
      tr.appendChild(el('td', null, p.username));
      var role = el('td');
      role.appendChild(el('span', 'tag ' + p.role, p.role));
      if (p.bannedAt) role.appendChild(el('span', 'tag banned', 'banned'));
      tr.appendChild(role);
      tr.appendChild(el('td', 'num', p.rating));
      tr.appendChild(el('td', 'num dim', p.wins + '/' + p.losses + '/' + p.draws));
      tr.appendChild(el('td', 'dim', ago(p.lastSeenAt)));

      var act = el('td', 'row');
      if (p.bannedAt) {
        var un = el('button', 'tiny', 'UNBAN');
        un.onclick = function () { post('/api/admin/unban', { playerId: p.id }, 'unbanned ' + p.username); };
        act.appendChild(un);
      } else {
        var ban = el('button', 'tiny danger', 'BAN');
        ban.onclick = function () { banPlayer(p); };
        act.appendChild(ban);
      }
      if (myRole === 'owner') {
        var next = p.role === 'player' ? 'admin' : 'player';
        var role_ = el('button', 'tiny', next === 'admin' ? 'MAKE ADMIN' : 'REVOKE');
        role_.onclick = function () { post('/api/admin/role', { playerId: p.id, role: next }, p.username + ' is now ' + next); };
        act.appendChild(role_);
      }
      tr.appendChild(act);
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderMatches(list) {
    var table = $('matches');
    clear(table);
    if (!list.length) { table.appendChild(el('caption', 'empty', 'No matches recorded yet.')); return; }
    head(table, ['#', 'Players', 'Result', 'Frames', 'When', 'Replay']);
    var body = el('tbody');
    list.forEach(function (m) {
      var tr = el('tr');
      tr.appendChild(el('td', 'dim num', m.id));
      tr.appendChild(el('td', null, m.players[0].name + ' vs ' + m.players[1].name));
      var result = m.winner === null ? 'draw' : m.players[m.winner].name + ' won';
      var td = el('td');
      td.appendChild(el('span', null, result));
      td.appendChild(el('div', 'dim mono', m.reason));
      tr.appendChild(td);
      tr.appendChild(el('td', 'num dim', m.frames));
      tr.appendChild(el('td', 'dim', ago(m.endedAt)));
      var rep = el('td');
      if (m.hasReplay) {
        var link = el('a', 'mono', 'download');
        link.href = '/api/matches/' + m.id + '/replay';
        link.setAttribute('download', 'tetrisvs-match-' + m.id + '.replay');
        rep.appendChild(link);
      } else rep.appendChild(el('span', 'dim', '—'));
      tr.appendChild(rep);
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderBoard(list) {
    var table = $('board');
    clear(table);
    if (!list.length) { table.appendChild(el('caption', 'empty', 'Nobody has finished a match yet.')); return; }
    head(table, ['#', 'Name', 'Rating', 'W/L', 'Lines', 'Best atk']);
    var body = el('tbody');
    list.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', 'dim num', row.rank));
      tr.appendChild(el('td', null, row.username));
      tr.appendChild(el('td', 'num', row.rating));
      tr.appendChild(el('td', 'num dim', row.wins + '/' + row.losses));
      tr.appendChild(el('td', 'num dim', row.lines));
      tr.appendChild(el('td', 'num dim', row.bestAttack));
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderAudit(list) {
    var table = $('audit');
    clear(table);
    if (!list.length) { table.appendChild(el('caption', 'empty', 'No operator actions yet.')); return; }
    head(table, ['When', 'Who', 'Action', 'Target']);
    var body = el('tbody');
    list.forEach(function (entry) {
      var tr = el('tr');
      tr.appendChild(el('td', 'dim', ago(entry.at)));
      tr.appendChild(el('td', null, entry.actor));
      tr.appendChild(el('td', 'mono', entry.action));
      var td = el('td', 'dim');
      td.appendChild(el('span', null, entry.target || '—'));
      if (entry.detail) td.appendChild(el('div', 'dim mono', entry.detail));
      tr.appendChild(td);
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  // ------------------------------------------------------------------ actions

  function post(path, body, okMessage) {
    return api(path, { method: 'POST', body: body }).then(function (r) {
      if (r.status >= 200 && r.status < 300) { toast(okMessage || 'Done.'); refresh(); }
      else toast(r.body.error || ('Failed (' + r.status + ')'));
      return r;
    });
  }

  function closeRoom(code) {
    if (!confirm('End the match in room ' + code + '? Both players see it as finished.')) return;
    post('/api/admin/room/close', { code: code, reason: 'closed by an operator' }, 'Room ' + code + ' closed.');
  }

  function kick_(socketId) {
    if (!confirm('Disconnect this connection?')) return;
    post('/api/admin/kick', { socketId: socketId }, 'Disconnected.');
  }

  function banPlayer(p) {
    var reason = prompt('Ban ' + p.username + '. Reason (shown to them at sign-in):', '');
    if (reason === null) return;
    post('/api/admin/ban', { playerId: p.id, reason: reason }, 'Banned ' + p.username + '.');
  }

  // ------------------------------------------------------------------ loop

  var players = [];
  var myRole = 'admin';

  function refresh() {
    return api('/api/admin/overview').then(function (r) {
      if (r.status === 401) return showGate('Session expired. Sign in again.', true);
      if (r.status === 403) return showGate('That account is not an operator.', true);
      if (r.status !== 200) { markStale(); return; }

      lastOk = Date.now();
      var data = r.body;
      myRole = data.me.role;
      $('who').textContent = data.me.username + ' · ' + data.me.role;
      $('link').textContent = 'LIVE';
      $('link').className = 'pill live';

      renderLive(data);
      renderRooms(data.server.rooms);
      renderConns(data.server.connections);
      renderMatches(data.recentMatches);
      renderBoard(data.leaderboard);
      renderAudit(data.audit);
      if (!players.length) loadPlayers('');
    }).catch(markStale);
  }

  function markStale() {
    $('link').textContent = Date.now() - lastOk > 8000 ? 'OFFLINE' : 'RETRYING';
    $('link').className = 'pill stale';
  }

  function loadPlayers(query) {
    api('/api/admin/players?q=' + encodeURIComponent(query || '')).then(function (r) {
      if (r.status !== 200) return;
      players = r.body.players || [];
      renderPlayers(players, myRole);
    });
  }

  function start() {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, 1000);
  }

  // ------------------------------------------------------------------ wiring

  $('signin').onclick = signIn;
  $('create').onclick = createAccount;
  $('claim').onclick = claimOwner;
  $('signout').onclick = signOut;
  $('p').onkeydown = function (e) { if (e.key === 'Enter') signIn(); };
  $('u').onkeydown = function (e) { if (e.key === 'Enter') $('p').focus(); };
  $('search').onclick = function () { loadPlayers($('q').value); };
  $('q').onkeydown = function (e) { if (e.key === 'Enter') loadPlayers($('q').value); };
  $('flush').onclick = function () { post('/api/admin/flush', {}, 'Write queue flushed.'); };
  $('toggle-maint').onclick = function () {
    var on = $('toggle-maint').textContent.indexOf('MAINTENANCE') >= 0;
    post('/api/admin/maintenance', { on: on }, on ? 'Maintenance mode on.' : 'Matchmaking resumed.');
  };
  $('set-notice').onclick = function () { post('/api/admin/notice', { notice: $('notice').value }, 'Notice sent.'); };
  $('clear-notice').onclick = function () { $('notice').value = ''; post('/api/admin/notice', { notice: '' }, 'Notice cleared.'); };

  // Stop polling while the tab is hidden — an idle console should cost nothing.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (timer) { clearInterval(timer); timer = null; } }
    else if (token && !$('app').classList.contains('hidden')) start();
  });

  if (token) start(); else showGate('', false);
})();
</script>
</body>
</html>`;
