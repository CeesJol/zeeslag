import {
  SIZE, LETTERS, FLEET, key, coordName, shipName, shipCells, canPlace, randomFleet,
  isFleetComplete, isValidFleet, resolveShot,
} from './game.js';

const PEER_PREFIX = 'zeeslag-nl-v1-';
const HEARTBEAT_MS = 3000;
const TIMEOUT_MS = 12000;
const DIAL_RETRY_MS = 4000;

const $ = (sel) => document.querySelector(sel);

let state = null;
let peer = null;
let conn = null;
let lastSeen = 0;
let dialTimer = null;
let pendingConn = null;
let hostRetries = 0;
let netProblem = null;
const placing = { selected: FLEET[0].id, horizontal: true, hover: null };

function freshRound() {
  return {
    phase: 'placing',
    myShips: [],
    myReady: false,
    oppReady: false,
    hostStarts: null,
    myTurn: false,
    pendingShot: null,
    incoming: {},
    outgoing: {},
    oppSunk: [],
    oppReveal: null,
    winner: null,
    rematchMe: false,
    rematchOpp: false,
    lastIncoming: null,
    lastOutgoing: null,
  };
}

function newState(gameId, role) {
  return {
    gameId, role, round: 1, score: { me: 0, opp: 0 }, net: { outSeq: 0, inSeq: 0, outbox: [] }, ...freshRound(),
  };
}

const storageKey = () => `zeeslag:${state.gameId}:${state.role}`;

function save() {
  try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch { /* private mode */ }
}

function load(gameId, role) {
  try { return JSON.parse(localStorage.getItem(`zeeslag:${gameId}:${role}`)); } catch { return null; }
}

function randomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

const inviteLink = () => `${location.origin}${location.pathname}#${state.gameId}`;

function init() {
  buildBoard($('#my-board'), 'my');
  buildBoard($('#opp-board'), 'opp');
  bindControls();
  window.addEventListener('hashchange', () => location.reload());

  const [gameId, flag] = location.hash.slice(1).split('/');
  if (!gameId) return showHome();
  if (!/^[a-z0-9]{6,16}$/.test(gameId)) return showHome('Deze link klopt niet. Start een nieuw spel.');
  const role = flag === 'h' ? 'host' : 'guest';
  state = load(gameId, role) ?? newState(gameId, role);
  placing.selected = nextUnplaced();
  save();
  startGame();
}

function showHome(error) {
  $('#home').hidden = false;
  if (error) {
    $('#home-error').textContent = error;
    $('#home-error').hidden = false;
  }
}

function startGame() {
  $('#home').hidden = true;
  $('#game').hidden = false;
  $('#score').hidden = false;
  $('#net').hidden = false;
  $('#invite-link').value = inviteLink();
  if (state.role === 'host') openHost(); else openGuest();
  setInterval(heartbeat, HEARTBEAT_MS);
  render();
}

function newGame() {
  state = newState(randomId(), 'host');
  history.replaceState(null, '', `#${state.gameId}/h`);
  save();
  startGame();
}

// The host owns the peer id in the link and the guest dials it. Ships stay in
// the owner's browser until the round ends, so nobody can peek.
function openHost() {
  const p = new Peer(PEER_PREFIX + state.gameId, { debug: 0 });
  peer = p;
  p.on('open', () => { hostRetries = 0; netProblem = null; render(); });
  p.on('connection', attach);
  watchSignaling(p, () => {
    hostRetries++;
    netProblem = hostRetries > 4 ? 'Dit spel is al open in een ander venster.' : null;
    setTimeout(openHost, 2500);
  }, openHost);
}

function openGuest() {
  const p = new Peer({ debug: 0 });
  peer = p;
  p.on('open', () => { netProblem = null; dial(); });
  p.on('error', (err) => {
    if (err.type !== 'peer-unavailable') return;
    pendingConn?.close();
    pendingConn = null;
    scheduleDial(DIAL_RETRY_MS);
  });
  watchSignaling(p, null, openGuest);
}

// The signaling server is only needed to set up a connection. Losing it must
// not end an open game connection, so a known peer reconnects instead of
// being destroyed.
function watchSignaling(p, onIdTaken, reopen) {
  const retry = () => setTimeout(() => {
    if (p !== peer) return;
    if (p.destroyed) reopen();
    else if (p.disconnected) p.reconnect();
  }, 3000);
  p.on('disconnected', retry);
  p.on('error', (err) => {
    if (err.type === 'unavailable-id' && onIdTaken) {
      p.destroy();
      onIdTaken();
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      netProblem = 'Geen verbinding met de server. Opnieuw proberen…';
      if (p.destroyed) retry();
    }
    render();
  });
}

function scheduleDial(ms) {
  clearTimeout(dialTimer);
  dialTimer = setTimeout(dial, ms);
}

function dial() {
  if (conn || !peer || peer.destroyed || !peer.open) return;
  pendingConn?.close();
  pendingConn = peer.connect(PEER_PREFIX + state.gameId, { reliable: true, serialization: 'json' });
  attach(pendingConn);
  scheduleDial(DIAL_RETRY_MS * 2);
}

function attach(c) {
  c.on('open', () => {
    if (state.role === 'guest' && c !== pendingConn) { c.close(); return; }
    pendingConn = null;
    if (conn && conn !== c) {
      const old = conn;
      conn = null;
      old.close();
    }
    conn = c;
    clearTimeout(dialTimer);
    lastSeen = Date.now();
    flushOutbox();
    render();
  });
  c.on('data', (msg) => {
    if (c !== conn) return;
    lastSeen = Date.now();
    receive(msg);
  });
  c.on('close', () => dropConn(c));
  c.on('error', () => dropConn(c));
}

function dropConn(c) {
  if (c !== conn) return;
  conn = null;
  try { c.close(); } catch { /* already closed */ }
  if (state.role === 'guest') scheduleDial(1000);
  render();
}

function heartbeat() {
  if (!conn) return;
  if (Date.now() - lastSeen > TIMEOUT_MS) return dropConn(conn);
  send({ type: 'ping', ack: state.net.inSeq });
  flushOutbox();
}

function send(msg) {
  if (conn?.open) conn.send(msg);
}

const isConnected = () => Boolean(conn?.open);

// Game messages are numbered and kept until the other side acknowledges them,
// and both sides persist the counters. So each message is applied exactly
// once and in order, also across a dead link, a reconnect or a reload.
function post(msg) {
  const m = { ...msg, seq: ++state.net.outSeq };
  state.net.outbox.push(m);
  send(m);
}

function flushOutbox() {
  for (const m of state.net.outbox) send(m);
}

function receive(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.ack === 'number') {
    state.net.outbox = state.net.outbox.filter((m) => m.seq > msg.ack);
  }
  if (typeof msg.seq !== 'number') return save();
  if (msg.seq === state.net.inSeq + 1) {
    state.net.inSeq = msg.seq;
    onMessage(msg);
  }
  send({ type: 'ack', ack: state.net.inSeq });
  save();
  render();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      if (msg.round !== state.round) return;
      state.oppReady = true;
      maybeStart();
      break;
    case 'start': onStart(msg); break;
    case 'shot': onShot(msg); break;
    case 'result': onResult(msg); break;
    case 'reveal':
      if (msg.round === state.round && Array.isArray(msg.ships)) state.oppReveal = msg.ships;
      break;
    case 'rematch':
      if (msg.round !== state.round || state.phase !== 'over') return;
      state.rematchOpp = true;
      maybeRematch();
      break;
    default:
  }
}

function maybeStart() {
  if (state.role !== 'host' || state.phase !== 'placing' || !state.myReady || !state.oppReady) return;
  state.hostStarts = Math.random() < 0.5;
  beginPlaying();
  post({ type: 'start', round: state.round, hostStarts: state.hostStarts });
}

function onStart(msg) {
  if (msg.round !== state.round || state.phase !== 'placing' || !state.myReady) return;
  state.hostStarts = Boolean(msg.hostStarts);
  beginPlaying();
}

function beginPlaying() {
  state.phase = 'playing';
  state.myTurn = (state.role === 'host') === state.hostStarts;
  toast(state.myTurn ? 'Jij mag beginnen!' : 'Je tegenstander begint.');
}

function onShot(msg) {
  const { r, c } = msg;
  if (msg.round !== state.round || !Number.isInteger(r) || !Number.isInteger(c)) return;
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
  const k = key(r, c);
  if (k in state.incoming || state.phase !== 'playing' || state.myTurn) return;

  const res = resolveShot(state.myShips, Object.keys(state.incoming), r, c);
  post({ type: 'result', round: state.round, r, c, result: res.result, ship: res.ship ?? null, allSunk: Boolean(res.allSunk) });

  state.incoming[k] = res.result === 'miss' ? 'miss' : 'hit';
  state.lastIncoming = k;
  const where = coordName(r, c);
  if (res.result === 'miss') toast(`Je tegenstander schoot op ${where}: mis.`);
  else if (res.result === 'hit') toast(`Je tegenstander schoot op ${where}: raak!`, 'bad');
  else toast(`Je tegenstander liet je ${shipName(res.ship.id).toLowerCase()} zinken.`, 'bad');

  if (res.allSunk) endRound('opp');
  else state.myTurn = true;
}

function onResult(msg) {
  const shot = state.pendingShot;
  if (msg.round !== state.round || !shot || msg.r !== shot.r || msg.c !== shot.c) return;
  const k = key(shot.r, shot.c);
  state.pendingShot = null;
  state.outgoing[k] = msg.result === 'miss' ? 'miss' : 'hit';
  state.lastOutgoing = k;
  if (msg.result === 'miss') toast(`${coordName(shot.r, shot.c)}: mis.`);
  else if (msg.result === 'hit') toast(`${coordName(shot.r, shot.c)}: raak!`, 'good');
  else {
    if (msg.ship) state.oppSunk.push(msg.ship);
    toast(`Gezonken! Je liet de ${shipName(msg.ship?.id).toLowerCase()} zinken.`, 'good');
  }
  if (msg.allSunk) endRound('me');
  else state.myTurn = false;
}

function endRound(winner) {
  state.phase = 'over';
  state.winner = winner;
  state.myTurn = false;
  state.score[winner]++;
  post({ type: 'reveal', round: state.round, ships: state.myShips });
}

function maybeRematch() {
  if (state.phase === 'over' && state.rematchMe && state.rematchOpp) nextRound();
}

function nextRound() {
  Object.assign(state, freshRound(), { round: state.round + 1 });
  placing.selected = FLEET[0].id;
  placing.hover = null;
}


function fire(r, c) {
  if (!canFire() || key(r, c) in state.outgoing) return;
  state.pendingShot = { r, c };
  post({ type: 'shot', round: state.round, r, c });
  save();
  render();
}

const canFire = () => isConnected() && state.phase === 'playing' && state.myTurn && !state.pendingShot;

function markReady() {
  if (!isValidFleet(state.myShips)) return;
  state.myReady = true;
  post({ type: 'ready', round: state.round, ready: true });
  maybeStart();
  save();
  render();
}

function requestRematch() {
  if (state.phase !== 'over' || state.rematchMe) return;
  state.rematchMe = true;
  post({ type: 'rematch', round: state.round });
  maybeRematch();
  save();
  render();
}


const canEditFleet = () => state?.phase === 'placing' && !state.myReady;
const nextUnplaced = () => FLEET.find((d) => !state.myShips.some((s) => s.id === d.id))?.id ?? null;

function previewCells() {
  if (!placing.selected || !placing.hover) return null;
  const def = FLEET.find((d) => d.id === placing.selected);
  const cells = shipCells(placing.hover[0], placing.hover[1], def.length, placing.horizontal);
  return { cells, ok: canPlace(state.myShips, cells) };
}

function pickUp(id) {
  const ship = state.myShips.find((s) => s.id === id);
  if (!ship) return;
  state.myShips = state.myShips.filter((s) => s.id !== id);
  placing.selected = id;
  if (ship.cells.length > 1) placing.horizontal = ship.cells[0][0] === ship.cells[1][0];
}

function placeAt(r, c) {
  const owner = state.myShips.find((s) => s.cells.some(([sr, sc]) => sr === r && sc === c));
  if (owner) {
    pickUp(owner.id);
  } else if (placing.selected && !state.myShips.some((s) => s.id === placing.selected)) {
    const preview = previewCells();
    if (!preview?.ok) return;
    state.myShips.push({ id: placing.selected, cells: preview.cells });
    placing.selected = nextUnplaced();
  }
  save();
  render();
}

function rotate() {
  if (!canEditFleet()) return;
  placing.horizontal = !placing.horizontal;
  render();
}


function buildBoard(el, side) {
  el.innerHTML = '';
  el.append(document.createElement('span'));
  for (let c = 0; c < SIZE; c++) el.append(label(LETTERS[c]));
  for (let r = 0; r < SIZE; r++) {
    el.append(label(String(r + 1)));
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.setAttribute('aria-label', coordName(r, c));
      el.append(cell);
    }
  }
  el.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    if (side === 'opp') fire(r, c);
    else if (canEditFleet()) placeAt(r, c);
  });
  if (side === 'my') {
    el.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || !state || !canEditFleet()) return;
      placing.hover = [Number(cell.dataset.r), Number(cell.dataset.c)];
      render();
    });
    el.addEventListener('mouseleave', () => {
      placing.hover = null;
      if (state) render();
    });
    el.addEventListener('contextmenu', (e) => {
      if (!canEditFleet()) return;
      e.preventDefault();
      rotate();
    });
  }
}

function label(text) {
  const span = document.createElement('span');
  span.className = 'label';
  span.textContent = text;
  return span;
}

function bindControls() {
  $('#new-game').addEventListener('click', newGame);
  $('#rotate').addEventListener('click', rotate);
  $('#random').addEventListener('click', () => {
    if (!canEditFleet()) return;
    state.myShips = randomFleet();
    placing.selected = null;
    save();
    render();
  });
  $('#clear').addEventListener('click', () => {
    if (!canEditFleet()) return;
    state.myShips = [];
    placing.selected = FLEET[0].id;
    save();
    render();
  });
  $('#ready').addEventListener('click', markReady);
  $('#rematch').addEventListener('click', requestRematch);
  $('#copy').addEventListener('click', async () => {
    const input = $('#invite-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('#copy').textContent = 'Gekopieerd!';
    setTimeout(() => { $('#copy').textContent = 'Kopieer'; }, 2000);
  });
  $('#picker').addEventListener('click', (e) => {
    const item = e.target.closest('[data-ship]');
    if (!item || !canEditFleet()) return;
    const id = item.dataset.ship;
    if (state.myShips.some((s) => s.id === id)) pickUp(id);
    else placing.selected = id;
    save();
    render();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'r' || e.key === 'R') && !e.target.closest('input')) rotate();
  });
}

const cellsOf = (ships) => new Map(ships.flatMap((s) => s.cells.map(([r, c]) => [key(r, c), s])));
const isShipSunk = (ship, shots) => ship.cells.every(([r, c]) => key(r, c) in shots);

function render() {
  if (!state) return;
  const connected = isConnected();
  const { phase } = state;

  $('#score').innerHTML = `Jij <b>${state.score.me}</b> – <b>${state.score.opp}</b> Tegenstander`;
  const net = $('#net');
  net.className = connected ? 'ok' : 'wait';
  $('#net-text').textContent = connected
    ? 'Verbonden'
    : netProblem ?? (state.role === 'host' ? 'Wachten op tegenstander…' : 'Verbinden met het spel…');

  $('#invite').hidden = !(state.role === 'host' && !connected);
  $('#placement').hidden = phase !== 'placing';
  $('#opp-wrap').hidden = phase === 'placing';
  $('#over-actions').hidden = phase !== 'over';

  renderStatus(connected);
  renderMyBoard();
  renderOppBoard();
  renderFleets();
  if (phase === 'placing') renderPlacement();
  if (phase === 'over') {
    $('#rematch').disabled = state.rematchMe;
    $('#rematch-note').textContent = state.rematchMe
      ? 'Wachten tot je tegenstander ook op "Nog een potje" klikt…'
      : state.rematchOpp ? 'Je tegenstander wil nog een potje!' : '';
  }
}

function renderStatus(connected) {
  const s = $('#status');
  let text;
  let tone = '';
  if (state.phase === 'placing') {
    if (!state.myReady) text = 'Plaats je schepen en klik op Klaar.';
    else if (!state.oppReady) text = 'Klaar! Wachten tot je tegenstander de schepen heeft geplaatst…';
    else text = 'Het spel begint…';
  } else if (state.phase === 'playing') {
    if (state.pendingShot) text = `Schot op ${coordName(state.pendingShot.r, state.pendingShot.c)}…`;
    else if (state.myTurn) { text = 'Jij bent aan de beurt. Kies een vakje bij de tegenstander.'; tone = 'turn'; }
    else text = 'Je tegenstander is aan de beurt…';
  } else {
    text = state.winner === 'me' ? 'Gewonnen! Je hebt de hele vloot laten zinken.' : 'Verloren. Je hele vloot is gezonken.';
    tone = state.winner === 'me' ? 'win' : 'lose';
  }
  if (!connected && state.phase === 'playing') text += ' (geen verbinding)';
  s.textContent = text;
  s.className = tone;
}

function renderMyBoard() {
  const shipAt = cellsOf(state.myShips);
  const preview = canEditFleet() ? previewCells() : null;
  const previewKeys = new Set(preview?.cells.map(([r, c]) => key(r, c)) ?? []);
  const board = $('#my-board');
  board.classList.toggle('editing', canEditFleet());
  for (const cell of board.querySelectorAll('.cell')) {
    const k = key(Number(cell.dataset.r), Number(cell.dataset.c));
    const ship = shipAt.get(k);
    const shot = state.incoming[k];
    cell.className = 'cell';
    if (ship) cell.classList.add('ship');
    if (ship && isShipSunk(ship, state.incoming)) cell.classList.add('sunk');
    else if (shot) cell.classList.add(shot);
    if (k === state.lastIncoming) cell.classList.add('last');
    if (previewKeys.has(k)) cell.classList.add(preview.ok ? 'preview-ok' : 'preview-bad');
  }
}

function renderOppBoard() {
  const sunkAt = cellsOf(state.oppSunk);
  const revealAt = cellsOf(state.oppReveal ?? []);
  const board = $('#opp-board');
  const pendingKey = state.pendingShot && key(state.pendingShot.r, state.pendingShot.c);
  board.classList.toggle('active', canFire());
  board.classList.toggle('waiting', state.phase === 'playing' && !state.myTurn);
  for (const cell of board.querySelectorAll('.cell')) {
    const k = key(Number(cell.dataset.r), Number(cell.dataset.c));
    const shot = state.outgoing[k];
    cell.className = 'cell';
    if (sunkAt.has(k)) cell.classList.add('ship', 'sunk');
    else if (shot) cell.classList.add(shot, ...(revealAt.has(k) ? ['ship'] : []));
    else if (revealAt.has(k)) cell.classList.add('ship', 'revealed');
    if (k === pendingKey) cell.classList.add('pending');
    if (k === state.lastOutgoing) cell.classList.add('last');
    cell.disabled = !canFire() || Boolean(shot);
  }
}

function fleetList(el, isSunk) {
  el.innerHTML = FLEET.map((def) => `
    <li class="${isSunk(def.id) ? 'sunk' : ''}">
      <span class="blocks">${'<i></i>'.repeat(def.length)}</span>${def.name}
    </li>`).join('');
}

function renderFleets() {
  fleetList($('#my-fleet'), (id) => {
    const ship = state.myShips.find((s) => s.id === id);
    return ship ? isShipSunk(ship, state.incoming) : false;
  });
  fleetList($('#opp-fleet'), (id) => state.oppSunk.some((s) => s.id === id));
  $('#my-fleet').hidden = state.phase === 'placing';
}

function renderPlacement() {
  const editable = canEditFleet();
  $('#picker').innerHTML = FLEET.map((def) => {
    const placed = state.myShips.some((s) => s.id === def.id);
    const selected = placing.selected === def.id;
    return `<li><button data-ship="${def.id}" class="${selected ? 'selected' : ''} ${placed ? 'placed' : ''}" ${editable ? '' : 'disabled'}>
      <span class="blocks">${'<i></i>'.repeat(def.length)}</span>${def.name}${placed ? ' ✓' : ''}
    </button></li>`;
  }).join('');
  for (const id of ['#rotate', '#random', '#clear']) $(id).disabled = !editable;
  $('#rotate').textContent = placing.horizontal ? 'Draai (nu liggend)' : 'Draai (nu staand)';
  $('#ready').disabled = !editable || !isFleetComplete(state.myShips);
  $('#ready').textContent = state.myReady ? 'Klaar ✓' : 'Klaar';
  $('#opp-ready').textContent = isConnected()
    ? (state.oppReady ? 'Je tegenstander is klaar.' : 'Je tegenstander plaatst nog schepen.')
    : '';
}

let toastTimer = null;
function toast(text, tone = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = `show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = tone; }, 2800);
}

init();
