let token = localStorage.getItem('tsc_token') || null;
let socket = null;

let currentUser = null;
let currentMatchId = null;
let currentAssignment = null; // { color, boardRole }
let latestState = null;

let boards = { 1: null, 2: null, 3: null };

function $(id) {
  return document.getElementById(id);
}

function setVisible(id, visible) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('hidden', !visible);
}

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function setStatus(text) {
  $('gameStatus').textContent = text || '';
}

function setQueueStatus(text) {
  $('queueStatus').textContent = text || '';
}

function setAuthError(text) {
  $('authError').textContent = text || '';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('API error'), { status: res.status, data });
  return data;
}

function connectSocket() {
	
  if (typeof io !== 'function') {
  throw new Error('Socket.IO client not loaded (io is not defined).');
  }
	
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });

  socket.on('fatal', (msg) => {
    setStatus(`Fatal: ${msg?.error || 'unknown'}`);
  });

  socket.on('hello', (msg) => {
    currentUser = msg.user;
    $('me').textContent = `${currentUser.username} (rating ${currentUser.rating})`;
    setVisible('authCard', false);
    setVisible('lobbyCard', true);
    setVisible('gameCard', false);
  });

  socket.on('queue_status', (msg) => {
    if (msg.status === 'queued') setQueueStatus(`Queued for ${msg.mode}…`);
    if (msg.status === 'matched') setQueueStatus(`Match found. Joining…`);
    if (msg.status === 'idle') setQueueStatus('');
  });

  socket.on('move_rejected', (msg) => {
	console.log('move_rejected', msg);
    setStatus(`Move rejected: ${msg.reason}`);
  });

  socket.on('match_state', (payload) => {
    latestState = payload;
    currentMatchId = payload.matchId;
    resolveAssignment(payload);
    renderMatch(payload);
  });
}

function resolveAssignment(payload) {
  if (!currentUser) return;
  const a = payload.assignments.find((x) => x.userId === currentUser.id);
  currentAssignment = a ? { color: a.color, boardRole: a.boardRole } : null;
}

function canDragPiece(boardIndex, piece) {
  if (!latestState || !currentAssignment) return false;
  if (latestState.endedAt) return false;

  const { board, color } = latestState.engine.currentTurn;
  if (board !== boardIndex) return false;

  // must be our color
  if (currentAssignment.color !== color) return false;

  if (latestState.mode === 'team') {
    if (currentAssignment.boardRole !== boardIndex) return false;
  }

  // piece must match our color
  const pieceColor = piece?.charAt(0) === 'w' ? 'w' : piece?.charAt(0) === 'b' ? 'b' : null;
  return pieceColor === color;
}

function initBoardsIfNeeded() {
  if (boards[1]) return;

  const mk = (idx) => Chessboard(`board${idx}`, {
    draggable: true,
    position: 'start',
    orientation: 'white',
    onDragStart: (source, piece) => {
      return canDragPiece(idx, piece);
    },
    onDrop: (source, target) => {
      // Always snap back (server authoritative).
      if (!socket || !currentMatchId) return 'snapback';
      socket.emit('move_attempt', {
        matchId: currentMatchId,
        boardIndex: idx,
        from: source,
        to: target,
        promotion: 'q'
      });
      return 'snapback';
    }
  });

  boards[1] = mk(1);
  boards[2] = mk(2);
  boards[3] = mk(3);
}

function renderTurnIndicators(engine) {
  for (let i = 1; i <= 3; i++) {
    const wrap = document.querySelector(`#board${i}`).closest('.boardWrap');
    wrap.classList.toggle('active', engine.currentTurn.board === i && !engine.boardFinished[i]);
    wrap.classList.toggle('finished', !!engine.boardFinished[i]);

    const ind = $(`turn${i}`);
    if (engine.boardFinished[i]) {
      ind.textContent = `Finished (${engine.boardResults[i]} wins)`;
    } else if (engine.currentTurn.board === i) {
      ind.textContent = `Active: ${engine.currentTurn.color === 'w' ? "White" : "Black"} to move`;
    } else {
      ind.textContent = 'Inactive';
    }
  }
}

function renderClocks(clock) {
  const w = clock.remainingMs.w;
  const b = clock.remainingMs.b;
  $('clockWhite').textContent = `White: ${fmtMs(w)}`;
  $('clockBlack').textContent = `Black: ${fmtMs(b)}`;

  $('clockWhite').classList.toggle('active', clock.activeColor === 'w' && clock.running);
  $('clockBlack').classList.toggle('active', clock.activeColor === 'b' && clock.running);
}

function renderMatch(payload) {
  initBoardsIfNeeded();

  setVisible('authCard', false);
  setVisible('lobbyCard', false);
  setVisible('gameCard', true);

  const orientation = currentAssignment?.color === 'b' ? 'black' : 'white';
  boards[1].orientation(orientation);
  boards[2].orientation(orientation);
  boards[3].orientation(orientation);

  boards[1].position(payload.engine.positions[1], false);
  boards[2].position(payload.engine.positions[2], false);
  boards[3].position(payload.engine.positions[3], false);

  renderTurnIndicators(payload.engine);
  renderClocks(payload.clock);

  const roleText = payload.mode === 'solo'
    ? `${currentAssignment?.color === 'w' ? 'White' : 'Black'} (controls all boards)`
    : `${currentAssignment?.color === 'w' ? 'White' : 'Black'} – Board ${currentAssignment?.boardRole}`;

  $('matchMeta').textContent = `Match ${payload.matchId} · ${payload.mode.toUpperCase()} · ${roleText}`;

  if (payload.endedAt) {
    const r = payload.result === 'draw' ? 'Draw' : payload.result === 'w' ? 'White wins' : 'Black wins';
    setStatus(`Game over: ${r} (${payload.termination})`);
  } else {
    setStatus('');
  }
}

function logout() {
  localStorage.removeItem('tsc_token');
  token = null;
  currentUser = null;
  currentMatchId = null;
  currentAssignment = null;
  latestState = null;
  if (socket) socket.disconnect();
  $('me').textContent = '';
  setVisible('authCard', true);
  setVisible('lobbyCard', false);
  setVisible('gameCard', false);
}

// ----------------------
// UI wiring
// ----------------------

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setAuthError('');
  const fd = new FormData(e.currentTarget);
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: { username: fd.get('username'), password: fd.get('password') }
    });
    token = data.token;
    localStorage.setItem('tsc_token', token);
    connectSocket();
  } catch (err) {
    setAuthError(err?.data?.error || 'Account created, but realtime failed: …');
  }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setAuthError('');
  const fd = new FormData(e.currentTarget);
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: { username: fd.get('username'), password: fd.get('password') }
    });
    token = data.token;
    localStorage.setItem('tsc_token', token);
    connectSocket();
  } catch (err) {
    setAuthError(err?.data?.error || 'Login failed');
  }
});

$('queueBtn').addEventListener('click', () => {
  if (!socket) return;
  setQueueStatus('');
  socket.emit('queue_join', {
    mode: $('modeSelect').value,
    timeControl: $('timeSelect').value
  });
});

$('leaveQueueBtn').addEventListener('click', () => {
  if (!socket) return;
  socket.emit('queue_leave');
});

$('logoutBtn').addEventListener('click', () => logout());

$('resignBtn').addEventListener('click', () => {
  if (!socket || !currentMatchId) return;
  socket.emit('resign', { matchId: currentMatchId });
});

$('backToLobbyBtn').addEventListener('click', () => {
  setVisible('gameCard', false);
  setVisible('lobbyCard', true);
});

// ----------------------
// Bootstrap
// ----------------------

(async function boot() {
  if (!token) {
    setVisible('authCard', true);
    setVisible('lobbyCard', false);
    setVisible('gameCard', false);
    return;
  }

  try {
    const me = await api('/api/me');
    currentUser = me.user;
    $('me').textContent = `${currentUser.username} (rating ${currentUser.rating})`;
    setVisible('authCard', false);
    setVisible('lobbyCard', true);
    setVisible('gameCard', false);
    connectSocket();
  } catch {
    logout();
  }
})();