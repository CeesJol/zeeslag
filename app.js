import {
  SIZE, LETTERS, FLEET, key, coordName, shipName, shipCells, canPlace, randomFleet,
  isFleetComplete, isValidFleet, resolveShot,
} from './game.js';

const PEER_PREFIX = 'zeeslag-nl-v1-';
const HEARTBEAT_MS = 3000;
const TIMEOUT_MS = 12000;
const DIAL_RETRY_MS = 4000;
const DRAG_THRESHOLD_PX = 5;

const $ = (sel) => document.querySelector(sel);

let state = null;
let peer = null;
let conn = null;
let linked = null;
let pendingConn = null;
let lastSeen = 0;
let dialTimer = null;
let hostRetries = 0;
let netProblem = null;
let blocked = false;
let wasLinked = false;
const placing = { selected: null, horizontal: true, hover: null, offset: 0 };
let drag = null;
let pointer = null;
let suppressClick = false;
let clearArmed = false;
let clearTimer = null;

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
  return { gameId, role, round: 1, score: { me: 0, opp: 0 }, ...freshRound() };
}

const storageKey = () => `zeeslag:${state.gameId}:${state.role}`;

function save() {
  // A ship that is being dragged is out of myShips; a reload must not lose it.
  const snapshot = drag?.moved && drag.origin ? { ...state, myShips: [...state.myShips, drag.origin] } : state;
  try { localStorage.setItem(storageKey(), JSON.stringify(snapshot)); } catch { /* private mode */ }
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
  lockGame(gameId, role, () => {
    state = load(gameId, role) ?? newState(gameId, role);
    startGame();
  });
}

// Two tabs with the same game and role would fight over the connection and
// overwrite each other's saved state, so only one tab may hold the game.
function lockGame(gameId, role, begin) {
  if (!navigator.locks) return begin();
  navigator.locks.request(`zeeslag:${gameId}:${role}`, { ifAvailable: true }, (lock) => {
    if (!lock) {
      showHome('Dit spel is al open in een ander tabblad. Ga naar dat tabblad.');
      return null;
    }
    begin();
    return new Promise(() => {});
  });
}

function showHome(error) {
  $('#home').hidden = false;
  if (error) {
    $('#home-error').textContent = error;
    $('#home-error').hidden = false;
  }
}

function startGame() {
  state.net ??= { outSeq: 0, inSeq: 0, outbox: [] };
  state.sessionId ??= randomId();
  state.oppSession ??= null;
  placing.selected = nextUnplaced();
  save();
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
  const gameId = randomId();
  lockGame(gameId, 'host', () => {
    state = newState(gameId, 'host');
    history.replaceState(null, '', `#${gameId}/h`);
    startGame();
  });
}

// The host owns the peer id in the link and the guest dials it. Ships stay in
// the owner's browser until the round ends, so nobody can peek.
function openHost() {
  if (blocked) return;
  const p = new Peer(PEER_PREFIX + state.gameId, { debug: 0 });
  peer = p;
  p.on('open', () => { hostRetries = 0; netProblem = null; render(); });
  p.on('connection', attach);
  watchSignaling(p, () => {
    hostRetries++;
    netProblem = hostRetries > 4 ? 'Dit spel is al open in een andere browser.' : null;
    setTimeout(openHost, 2500);
  }, openHost);
}

function openGuest() {
  if (blocked) return;
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
    if (p !== peer || blocked) return;
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
  if (blocked || conn || !peer || peer.destroyed || !peer.open) return;
  pendingConn?.close();
  pendingConn = peer.connect(PEER_PREFIX + state.gameId, { reliable: true, serialization: 'json' });
  attach(pendingConn);
  scheduleDial(DIAL_RETRY_MS * 2);
}

function attach(c) {
  c.on('open', () => {
    if (blocked || (state.role === 'guest' && c !== pendingConn)) { c.close(); return; }
    pendingConn = null;
    if (conn && conn !== c) {
      const old = conn;
      conn = null;
      linked = null;
      old.close();
    }
    conn = c;
    clearTimeout(dialTimer);
    lastSeen = Date.now();
    sendHello();
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
  linked = null;
  try { c.close(); } catch { /* already closed */ }
  if (state.role === 'guest') scheduleDial(1000);
  render();
}

function heartbeat() {
  if (!conn) return;
  if (Date.now() - lastSeen > TIMEOUT_MS) return dropConn(conn);
  if (!linked) return sendHello();
  transmit({ type: 'ping', ack: state.net.inSeq });
  flushOutbox();
}

const isConnected = () => Boolean(linked?.open);

// Each saved game has a session id. Once the two sides have exchanged a game
// message, a hello with another session id means a second browser or a lost
// save; mixing the two would corrupt both games, so that link is refused.
// Before that, a new session may replace the old one (for example, the host
// tried the invite link in its own browser first).
function sendHello() {
  if (conn?.open) conn.send({ type: 'hello', session: state.sessionId, linked: linked === conn });
}

function onHello(msg) {
  if (typeof msg.session !== 'string') return;
  if (linked !== conn) {
    const untouched = state.net.inSeq === 0 && state.net.outbox.length === state.net.outSeq;
    if (!state.oppSession || untouched) state.oppSession = msg.session;
    if (msg.session !== state.oppSession) return refuse(conn);
    linked = conn;
    netProblem = null;
    toast(wasLinked ? 'Weer verbonden met je tegenstander.' : 'Je tegenstander is verbonden!', 'good');
    wasLinked = true;
    save();
    transmit({ type: 'ping', ack: state.net.inSeq });
    flushOutbox();
  }
  if (!msg.linked) sendHello();
  render();
}

function refuse(c) {
  c.send({ type: 'busy' });
  conn = null;
  linked = null;
  setTimeout(() => c.close(), 1000);
  if (state.role === 'guest') scheduleDial(DIAL_RETRY_MS);
  render();
}

function onBusy() {
  blocked = true;
  clearTimeout(dialTimer);
  conn = null;
  linked = null;
  try { peer?.destroy(); } catch { /* already gone */ }
  netProblem = 'Geen verbinding';
  render();
}

function transmit(msg) {
  if (linked?.open) linked.send({ ...msg, from: state.sessionId, to: state.oppSession });
}

// Game messages are numbered and kept until the other side acknowledges them,
// and both sides persist the counters. So each message is applied exactly
// once and in order, also across a dead link, a reconnect or a reload.
function post(msg) {
  const m = { ...msg, seq: ++state.net.outSeq };
  state.net.outbox.push(m);
  transmit(m);
}

function flushOutbox() {
  for (const m of state.net.outbox) transmit(m);
}

function receive(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') return onHello(msg);
  if (msg.type === 'busy') return onBusy();
  if (!linked || msg.from !== state.oppSession || msg.to !== state.sessionId) return;
  if (typeof msg.ack === 'number') {
    state.net.outbox = state.net.outbox.filter((m) => m.seq > msg.ack);
  }
  if (typeof msg.seq !== 'number') return save();
  if (msg.seq === state.net.inSeq + 1) {
    state.net.inSeq = msg.seq;
    onMessage(msg);
  }
  transmit({ type: 'ack', ack: state.net.inSeq });
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
    if (Array.isArray(msg.ship?.cells)) state.oppSunk.push(msg.ship);
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
  placing.offset = 0;
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
const shipAtCell = (r, c) => state.myShips.find((s) => s.cells.some(([sr, sc]) => sr === r && sc === c));
const isHorizontal = (ship) => ship.cells.length < 2 || ship.cells[0][0] === ship.cells[1][0];

// `offset` is the index of the ship cell under the pointer, so a ship that is
// dragged by its middle stays under the pointer at the same spot.
function previewCells() {
  if (!placing.selected || !placing.hover) return null;
  const def = FLEET.find((d) => d.id === placing.selected);
  const [hr, hc] = placing.hover;
  const r = placing.horizontal ? hr : hr - placing.offset;
  const c = placing.horizontal ? hc - placing.offset : hc;
  const cells = shipCells(r, c, def.length, placing.horizontal);
  return { cells, ok: canPlace(state.myShips, cells) };
}

function selectShip(id) {
  placing.selected = id;
  placing.offset = 0;
}

function pickUp(ship, offset = 0) {
  state.myShips = state.myShips.filter((s) => s !== ship);
  placing.selected = ship.id;
  placing.offset = offset;
  placing.horizontal = isHorizontal(ship);
}

function dropSelected() {
  const preview = previewCells();
  if (!preview?.ok || state.myShips.some((s) => s.id === placing.selected)) return false;
  state.myShips.push({ id: placing.selected, cells: preview.cells });
  selectShip(nextUnplaced());
  return true;
}

function clickCell(r, c) {
  const owner = shipAtCell(r, c);
  if (owner) pickUp(owner, owner.cells.findIndex(([sr, sc]) => sr === r && sc === c));
  else if (placing.selected) dropSelected();
  save();
  render();
}

// Rotates the ship in hand around the cell under the pointer. Without a ship
// in hand, a placed ship under the pointer turns in place.
function rotate(x = pointer?.[0], y = pointer?.[1]) {
  if (!canEditFleet()) return;
  const cell = x === undefined ? null : boardCellAt(x, y);
  const rc = cell && [Number(cell.dataset.r), Number(cell.dataset.c)];
  const placed = rc && !drag?.moved && shipAtCell(...rc);
  if (placed) return rotatePlaced(placed, rc);
  placing.horizontal = !placing.horizontal;
  if (rc) placing.hover = rc;
  updateGhost();
  render();
}

function rotatePlaced(ship, [r, c]) {
  const others = state.myShips.filter((s) => s !== ship);
  const horizontal = !isHorizontal(ship);
  const pivot = ship.cells.findIndex(([sr, sc]) => sr === r && sc === c);
  const order = [pivot, ...ship.cells.keys()].filter((i, n, all) => all.indexOf(i) === n);
  for (const i of order) {
    const cells = shipCells(horizontal ? r : r - i, horizontal ? c - i : c, ship.cells.length, horizontal);
    if (canPlace(others, cells)) {
      ship.cells = cells;
      save();
      render();
      return;
    }
  }
  toast('Hier is geen ruimte om dit schip te draaien.', 'bad');
}

function startDrag(e, id, origin, offset) {
  if (e.button !== 0 || !canEditFleet()) return;
  drag = { id, origin, offset, x: e.clientX, y: e.clientY, moved: false };
}

function moveDrag(e) {
  pointer = [e.clientX, e.clientY];
  if (!drag) return;
  if (!(e.buttons & 1)) return endDrag(true);
  // Chrome sends no contextmenu event while the left button is down, so a
  // right-button press during a drag only shows up here.
  const right = Boolean(e.buttons & 2);
  if (right && !drag.right && drag.moved) rotate(e.clientX, e.clientY);
  drag.right = right;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    if (drag.origin) pickUp(drag.origin, drag.offset);
    else selectShip(drag.id);
    document.body.classList.add('dragging');
    updateGhost();
  }
  const cell = boardCellAt(e.clientX, e.clientY);
  placing.hover = cell ? [Number(cell.dataset.r), Number(cell.dataset.c)] : null;
  const ghost = $('#ghost');
  ghost.hidden = Boolean(placing.hover);
  ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
  render();
}

// The 2 px gap between cells is part of the board, not of a cell. A drop
// there must still land on the nearest cell, so look 2 px around the point.
function boardCellAt(x, y) {
  for (const [dx, dy] of [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]]) {
    const cell = document.elementFromPoint(x + dx, y + dy)?.closest?.('#my-board .cell');
    if (cell) return cell;
  }
  return null;
}

function endDrag(cancel = false) {
  if (!drag) return;
  const { moved, origin } = drag;
  drag = null;
  if (!moved) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  document.body.classList.remove('dragging');
  $('#ghost').hidden = true;
  if ((cancel || !dropSelected()) && origin) {
    state.myShips.push(origin);
    selectShip(nextUnplaced());
  }
  placing.hover = null;
  save();
  render();
}

function updateGhost() {
  const def = FLEET.find((d) => d.id === placing.selected);
  const ghost = $('#ghost');
  if (!def) return;
  ghost.innerHTML = '<i></i>'.repeat(def.length);
  ghost.classList.toggle('vertical', !placing.horizontal);
}

function armClear() {
  if (!canEditFleet() || !state.myShips.length) return;
  clearTimeout(clearTimer);
  if (!clearArmed) {
    clearArmed = true;
    clearTimer = setTimeout(() => { clearArmed = false; render(); }, 3000);
  } else {
    clearArmed = false;
    state.myShips = [];
    selectShip(FLEET[0].id);
    save();
  }
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
  const cellOf = (e) => {
    const cell = e.target.closest('.cell');
    return cell && [Number(cell.dataset.r), Number(cell.dataset.c)];
  };
  el.addEventListener('click', (e) => {
    const rc = cellOf(e);
    if (!rc || suppressClick) return;
    if (side === 'opp') fire(...rc);
    else if (canEditFleet()) clickCell(...rc);
  });
  if (side !== 'my') return;
  el.addEventListener('pointerdown', (e) => {
    const rc = cellOf(e);
    const ship = rc && canEditFleet() && shipAtCell(...rc);
    if (!ship || e.button !== 0) return;
    e.preventDefault();
    const offset = ship.cells.findIndex(([r, c]) => r === rc[0] && c === rc[1]);
    startDrag(e, ship.id, ship, offset);
  });
  el.addEventListener('mouseover', (e) => {
    const rc = cellOf(e);
    if (!rc || drag || !canEditFleet()) return;
    placing.hover = rc;
    render();
  });
  el.addEventListener('mouseleave', () => {
    if (!state || drag) return;
    placing.hover = null;
    render();
  });
}

function label(text) {
  const span = document.createElement('span');
  span.className = 'label';
  span.textContent = text;
  return span;
}

function bindControls() {
  $('#new-game').addEventListener('click', newGame);
  $('#rotate').addEventListener('click', () => rotate(undefined));
  $('#random').addEventListener('click', () => {
    if (!canEditFleet()) return;
    state.myShips = randomFleet();
    selectShip(null);
    save();
    render();
  });
  $('#clear').addEventListener('click', armClear);
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
  $('#picker').addEventListener('pointerdown', (e) => {
    const item = e.target.closest('[data-ship]');
    if (!item || !canEditFleet() || e.button !== 0) return;
    e.preventDefault();
    const id = item.dataset.ship;
    startDrag(e, id, state.myShips.find((s) => s.id === id) ?? null, 0);
  });
  $('#picker').addEventListener('click', (e) => {
    const item = e.target.closest('[data-ship]');
    if (!item || !canEditFleet() || suppressClick) return;
    const placed = state.myShips.find((s) => s.id === item.dataset.ship);
    if (placed) pickUp(placed);
    else selectShip(item.dataset.ship);
    save();
    render();
  });
  document.addEventListener('pointermove', moveDrag);
  document.addEventListener('pointerup', () => endDrag());
  document.addEventListener('pointercancel', () => endDrag(true));
  document.addEventListener('contextmenu', (e) => {
    if (!canEditFleet() || !(drag || e.target.closest?.('#my-board'))) return;
    e.preventDefault();
    if (!drag?.moved) rotate(e.clientX, e.clientY);
  });
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') {
      e.preventDefault();
      rotate();
    }
  });
}

const cellsOf = (ships) => new Map(ships.flatMap((s) => s.cells.map(([r, c]) => [key(r, c), s])));
const isShipSunk = (ship, shots) => ship.cells.every(([r, c]) => key(r, c) in shots);

function render() {
  if (!state) return;
  const connected = isConnected();
  const { phase } = state;

  $('#score').innerHTML = `Jij <b>${state.score.me}</b> – <b>${state.score.opp}</b> Tegenstander`;
  $('#net').className = connected ? 'ok' : blocked ? 'blocked' : 'wait';
  $('#net-text').textContent = connected ? 'Verbonden' : netProblem ?? 'Wachten op je tegenstander…';

  $('#invite').hidden = !(state.role === 'host' && !connected && !blocked);
  $('#boards').hidden = blocked;
  $('#placement').hidden = phase !== 'placing';
  $('#opp-wrap').hidden = phase === 'placing';
  $('#over-actions').hidden = phase !== 'over' || blocked;

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
  document.title = phase === 'playing' && state.myTurn && !state.pendingShot ? '🎯 Jouw beurt – Zeeslag' : 'Zeeslag';
}

function renderStatus(connected) {
  const s = $('#status');
  let text;
  let tone = '';
  if (blocked) {
    text = state.role === 'guest'
      ? 'Dit spel wordt al gespeeld in een andere browser. Open de link in de browser waarin je eerder speelde.'
      : 'Dit spel is al open in een andere browser. Gebruik die browser, of start een nieuw spel.';
    tone = 'lose';
  } else if (state.phase === 'placing') {
    if (!state.myReady) text = 'Plaats je schepen en klik op Klaar.';
    else if (!state.oppReady) text = 'Klaar! Wachten tot je tegenstander de schepen heeft geplaatst…';
    else text = 'Het spel begint…';
  } else if (state.phase === 'playing') {
    if (!connected) text = 'Geen verbinding met je tegenstander. Even wachten…';
    else if (state.pendingShot) text = `Schot op ${coordName(state.pendingShot.r, state.pendingShot.c)}…`;
    else if (state.myTurn) { text = 'Jij bent aan de beurt. Kies een vakje bij de tegenstander.'; tone = 'turn'; }
    else text = 'Je tegenstander is aan de beurt…';
  } else {
    text = state.winner === 'me' ? 'Gewonnen! Je hebt de hele vloot laten zinken.' : 'Verloren. Je hele vloot is gezonken.';
    tone = state.winner === 'me' ? 'win' : 'lose';
  }
  s.textContent = text;
  s.className = tone;
}

function renderMyBoard() {
  const shipAt = cellsOf(state.myShips);
  // Over a placed ship the click picks that ship up, so the preview of the
  // next ship would only hide what the click does.
  const overShip = !drag?.moved && placing.hover && shipAtCell(...placing.hover);
  const preview = canEditFleet() && !overShip ? previewCells() : null;
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
  $('#rotate').disabled = !editable;
  $('#random').disabled = !editable;
  $('#clear').disabled = !editable || !state.myShips.length;
  $('#clear').textContent = clearArmed ? 'Zeker? Klik nog eens' : 'Wissen';
  $('#clear').classList.toggle('danger', clearArmed);
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
