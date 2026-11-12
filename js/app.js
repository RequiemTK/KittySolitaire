// Kitty Solitaire - screens, drawing, input and animation.
import * as L from './logic.js';
import { BACKGROUNDS } from './backgrounds.js';

const $ = (id) => document.getElementById(id);
const board = $('board');
const cap = window.Capacitor;
const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());

const SUIT_CH = ['♠', '♥', '♣', '♦'].map((c) => c + '︎');
const SUIT_CLASS = ['s', 'h', 'c', 'd'];
const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_DESC = { 1: 'Easy – spades only', 2: 'Medium – spades and hearts', 3: 'Hard – spades, hearts and clubs', 4: 'Expert – all four suits' };
const MOVE_MS = 280;

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const prefs = Object.assign({ suits: 3, allowEmptyDeal: false, bg: null }, store.get('kitty.prefs', {}));
const savePrefs = () => store.set('kitty.prefs', prefs);

// Compact text form of a position, used for undo history and the save file.
const b36 = (n) => n.toString(36);
const un36 = (t) => (t ? t.split(',').map((x) => parseInt(x, 36)) : []);
function encode(s) {
  return [
    s.cols.map((c) => c.map((k) => b36(k.id * 2 + (k.up ? 1 : 0))).join(',')).join('|'),
    s.stock.map(b36).join(','),
    s.done.map((d) => d.map(b36).join(',')).join('|'),
    s.moves,
  ].join(';');
}
function decode(t, suits, allowEmptyDeal) {
  const [c, st, d, m] = t.split(';');
  return {
    suits, allowEmptyDeal,
    cols: c.split('|').map((x) => un36(x).map((v) => ({ id: v >> 1, up: !!(v & 1) }))),
    stock: un36(st),
    done: d ? d.split('|').map(un36) : [],
    moves: +m,
  };
}

// ---------------------------------------------------------------- game state
let S = null;          // current position
let history = [];      // encoded earlier positions (unlimited undo)
let initial = '';      // encoded starting deal (for Restart)
let elapsed = 0;       // ms of play time
let started = false;   // timer starts on the first action
let won = false;
let lockUntil = 0;     // ignore input while a deal animation plays
let cardEls = [];      // id -> element
let builtSuits = 0;
let pos = [];          // id -> { w:'col'|'stock'|'done', c, i }
let base = [];         // id -> { x, y }
let M = null;          // last layout metrics
let zToken = 0;

function saveGame() {
  if (!S || won) return;
  const data = { suits: S.suits, allow: S.allowEmptyDeal, cur: encode(S), history, initial, elapsed, started };
  while (!store.set('kitty.save', data) && data.history.length > 20) {
    data.history = history = history.slice(Math.ceil(history.length / 2)); // storage full: drop oldest undo steps
  }
}

// ---------------------------------------------------------------- background
const layers = document.querySelectorAll('.bgl');
let layerOn = 0;
function setBackground(name, fade = true) {
  const url = `img/bg/${name}`;
  const img = new Image();
  img.onload = () => {
    const next = layers[1 - layerOn];
    next.style.backgroundImage = `url("${url}")`;
    if (!fade) layers.forEach((l) => (l.style.transition = 'none'));
    next.classList.add('on');
    layers[layerOn].classList.remove('on');
    layerOn = 1 - layerOn;
    if (!fade) requestAnimationFrame(() => layers.forEach((l) => (l.style.transition = '')));
  };
  img.src = url;
}
function newBackground() {
  let name;
  do { name = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)]; }
  while (BACKGROUNDS.length > 1 && name === prefs.bg);
  prefs.bg = name;
  savePrefs();
  setBackground(name);
}

// ---------------------------------------------------------------- cards
function buildCards() {
  if (builtSuits === S.suits && cardEls.length) return;
  board.querySelectorAll('.card').forEach((e) => e.remove());
  cardEls = [];
  for (let id = 0; id < 104; id++) {
    const suit = L.suitOf(S, id);
    const el = document.createElement('div');
    el.className = 'card instant';
    el.dataset.id = id;
    el.innerHTML =
      `<div class="inner"><div class="face ${SUIT_CLASS[suit]}">` +
      `<div class="corner"><span>${RANKS[L.rankOf(id)]}</span><span>${SUIT_CH[suit]}</span></div>` +
      `<div class="pip">${SUIT_CH[suit]}</div></div><div class="back"></div></div>`;
    board.appendChild(el);
    cardEls.push(el);
  }
  builtSuits = S.suits;
}
const slots = [];
for (let c = 0; c < L.COLS; c++) {
  const s = document.createElement('div');
  s.className = 'slot';
  board.appendChild(s);
  slots.push(s);
}

// ---------------------------------------------------------------- layout
function metrics() {
  const W = board.clientWidth, H = board.clientHeight;
  const short = H < 480;
  const top = short ? 48 : 60;
  let cw = Math.min(W / (10 + 11 * 0.08), ((H - top) * 0.3) / 1.4, 150);
  const ch = cw * 1.4;
  const gx = (W - 10 * cw) / 11;
  const ps = short ? 0.72 : 1;                  // bottom piles are drawn smaller on short screens
  const pw = cw * ps, ph = ch * ps;
  const py = H - ph - 8;
  return { W, H, top, cw, ch, gx, ps, pw, ph, py, soff: pw * 0.2, foff: pw * 0.3, colX: (c) => gx + c * (cw + gx) };
}

/**
 * Moves every card to where the current position says it belongs.
 * opts.instant   - no animation
 * opts.delays    - Map(id -> ms) to stagger the flight of individual cards
 * opts.fromStock - park every card on the stock pile (start of the deal animation)
 */
function place(opts = {}) {
  if (!S) return;
  const m = (M = metrics());
  board.style.setProperty('--cw', m.cw + 'px');
  board.style.setProperty('--ch', m.ch + 'px');
  const piles = Math.ceil(S.stock.length / L.COLS);
  const stockLeft = m.W - m.gx - m.pw - Math.max(0, piles - 1) * m.soff;
  const foundRight = m.gx + m.pw + Math.max(0, S.done.length - 1) * m.foff;

  const put = (id, x, y, z, up, scale, where) => {
    const el = cardEls[id];
    const d = (opts.delays && opts.delays.get(id)) || 0;
    const tf = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${scale})`;
    const moving = !opts.instant && el.style.transform !== tf;
    el.classList.toggle('instant', !!opts.instant);
    el.classList.remove('drag');
    el.style.transitionDelay = d ? d + 'ms' : '';
    el.style.transform = tf;
    if (el.classList.contains('up') !== up) {
      const inner = el.firstChild, back = inner.lastChild;
      if (opts.instant) el.classList.remove('flip');
      else {
        // squash-flip, swapping face and back at the midpoint
        el.classList.remove('flip');
        void inner.offsetWidth;
        inner.style.animationDelay = d + 'ms';
        back.style.transitionDelay = d + 150 + 'ms';
        el.classList.add('flip');
        clearTimeout(el._flipT);
        el._flipT = setTimeout(() => el.classList.remove('flip'), d + 340);
      }
      el.classList.toggle('up', up);
    }
    const now = performance.now();
    el._z = z;
    if (moving) el._until = now + d + MOVE_MS;
    if (el._until > now) {
      el.style.zIndex = 2000 + z; // fly above everything, settle afterwards
      setTimeout(() => {
        if (performance.now() >= el._until - 5 && !el.classList.contains('drag')) el.style.zIndex = el._z;
      }, el._until - now + 30);
    } else el.style.zIndex = z;
    pos[id] = where;
    base[id] = { x, y };
  };

  if (opts.fromStock) {
    const x = m.W - m.gx - m.pw;
    for (let id = 0; id < 104; id++) put(id, x, m.py, id, false, m.ps, { w: 'stock' });
    return;
  }

  for (let c = 0; c < L.COLS; c++) {
    const col = S.cols[c];
    const x = m.colX(c);
    slots[c].style.transform = `translate3d(${x}px,${m.top}px,0)`;
    let limit = m.H - 6;
    if ((piles && x + m.cw > stockLeft - 2) || (S.done.length && x < foundRight + 2)) limit = m.py - 6;
    // Squeeze the overlap so a long column still fits on screen.
    let dn = m.ch * 0.11, up = m.ch * 0.27;
    const nUp = col.filter((k) => k.up).length, nDn = col.length - nUp;
    const room = limit - m.top - m.ch;
    const need = () => (col.length ? nDn * dn + (nUp - 1) * up : 0);
    if (need() > room && nUp > 1) up = Math.max(m.ch * 0.19, (room - nDn * dn) / (nUp - 1));
    if (need() > room) { const k = Math.max(0.2, room / need()); dn *= k; up *= k; }
    let y = m.top;
    col.forEach((k, i) => {
      put(k.id, x, y, i + 1, k.up, 1, { w: 'col', c, i });
      y += k.up ? up : dn;
    });
  }
  S.stock.forEach((id, i) => {
    const p = Math.floor(i / L.COLS);
    put(id, m.W - m.gx - m.pw - p * m.soff, m.py, 10 + i, false, m.ps, { w: 'stock' });
  });
  S.done.forEach((set, n) => {
    set.forEach((id, k) => put(id, m.gx + n * m.foff, m.py, 100 + n * 13 + (12 - k), true, m.ps, { w: 'done' }));
  });
  $('undo').classList.toggle('off', !history.length);
}

// ---------------------------------------------------------------- helpers
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
function shake(els) {
  els.forEach((el) => {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 320);
  });
}
let hintTimer = 0;
function clearHint() {
  clearTimeout(hintTimer);
  board.querySelectorAll('.hint, .hint-to').forEach((e) => e.classList.remove('hint', 'hint-to'));
}
const fmtTime = (ms) => {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
const statsHtml = () =>
  `<div><b>${L.score(S)}</b><span>Score</span></div><div><b>${fmtTime(elapsed)}</b><span>Time</span></div><div><b>${S.moves}</b><span>Moves</span></div>`;
const locked = () => performance.now() < lockUntil || won;

// ---------------------------------------------------------------- actions
/** Stagger for cards flying to the finished-sets pile. */
function completionDelays(delays, fromSet, startAt) {
  for (let n = fromSet; n < S.done.length; n++) {
    S.done[n].forEach((id, k) => delays.set(id, startAt + (n - fromSet) * 200 + (12 - k) * 40));
  }
  return S.done.length > fromSet ? startAt + (S.done.length - fromSet) * 200 + 13 * 40 + MOVE_MS : 0;
}
function afterAction(delays, doneBefore, startAt) {
  started = true;
  const busy = completionDelays(delays, doneBefore, startAt);
  place({ delays });
  if (L.isWon(S)) {
    won = true;
    store.del('kitty.save');
    setTimeout(showWin, busy + 250);
  } else saveGame();
}
function doMove(from, idx, to) {
  const before = encode(S), doneBefore = S.done.length;
  if (!L.move(S, from, idx, to)) return false;
  history.push(before);
  afterAction(new Map(), doneBefore, MOVE_MS);
  return true;
}
function doDeal() {
  const why = L.dealBlocked(S);
  if (why === 'gap') { toast('Fill every empty column before dealing more cards'); shake(S.stock.slice(-1).map((id) => cardEls[id])); return; }
  if (why) return;
  const before = encode(S), doneBefore = S.done.length;
  const r = L.deal(S);
  history.push(before);
  const delays = new Map();
  r.dealt.forEach((id, i) => delays.set(id, i * 70));
  const end = r.dealt.length * 70 + MOVE_MS;
  lockUntil = performance.now() + end;
  afterAction(delays, doneBefore, end);
}
function doUndo() {
  if (locked()) return;
  clearHint();
  if (!history.length) { toast('Nothing to undo'); return; }
  const moves = S.moves;
  S = decode(history.pop(), S.suits, S.allowEmptyDeal);
  S.moves = moves + 1; // an undo still counts as a move
  place();
  saveGame();
}
function doHint() {
  if (locked()) return;
  clearHint();
  const h = L.hint(S);
  if (!h) { toast('No moves left – try Undo, or start a new game from the menu'); return; }
  if (h.type === 'deal') {
    cardEls[S.stock[S.stock.length - 1]].classList.add('hint');
  } else {
    S.cols[h.from].slice(h.idx).forEach((k) => cardEls[k.id].classList.add('hint'));
    const t = S.cols[h.to];
    (t.length ? cardEls[t[t.length - 1].id] : slots[h.to]).classList.add('hint-to');
  }
  hintTimer = setTimeout(clearHint, 3500);
}

// ---------------------------------------------------------------- pointer input
let drag = null;
board.addEventListener('pointerdown', (e) => {
  if (drag || locked() || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = e.target.closest('.card');
  if (!el) return;
  e.preventDefault();
  clearHint();
  const p = pos[+el.dataset.id];
  if (p.w === 'stock') { doDeal(); return; }
  if (p.w !== 'col' || !S.cols[p.c][p.i].up) return;
  if (!L.canPickup(S, p.c, p.i)) { shake([el]); return; }
  drag = { pid: e.pointerId, c: p.c, i: p.i, ids: S.cols[p.c].slice(p.i).map((k) => k.id), sx: e.clientX, sy: e.clientY, moved: false };
  try { board.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
board.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 7) return;
    drag.moved = true;
    drag.ids.forEach((id, k) => { cardEls[id].classList.add('drag'); cardEls[id].style.zIndex = 5000 + k; });
  }
  drag.dx = dx;
  drag.ids.forEach((id) => {
    cardEls[id].style.transform = `translate3d(${base[id].x + dx}px,${base[id].y + dy}px,0) scale(1)`;
  });
});
function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag;
  drag = null;
  const els = d.ids.map((id) => cardEls[id]);
  if (cancelled) { place(); return; }
  if (!d.moved) {
    // Tap: send the cards to the best legal spot.
    const to = L.autoTarget(S, d.c, d.i);
    if (to < 0) shake(els); else doMove(d.c, d.i, to);
    return;
  }
  els.forEach((el) => el.classList.remove('drag'));
  const centre = base[d.ids[0]].x + d.dx + M.cw / 2;
  const near = [...Array(L.COLS).keys()]
    .map((c) => ({ c, dist: Math.abs(M.colX(c) + M.cw / 2 - centre) }))
    .filter((o) => o.dist < M.cw * 0.95 && o.c !== d.c)
    .sort((a, b) => a.dist - b.dist);
  for (const o of near) if (doMove(d.c, d.i, o.c)) return;
  place(); // not a legal drop: glide back
}
board.addEventListener('pointerup', (e) => endDrag(e, false));
board.addEventListener('pointercancel', (e) => endDrag(e, true));
board.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());

// ---------------------------------------------------------------- screens & dialogs
const dlgOpen = () => document.querySelector('.dlg.open');
const openDlg = (id) => $(id).classList.add('open');
const closeDlg = (id) => $(id).classList.remove('open');
let screen = 'menu';
function show(name) {
  screen = name;
  $('menu').hidden = name !== 'menu';
  $('game').hidden = name !== 'game';
}
function showMenu() {
  stopFx();
  document.querySelectorAll('.dlg.open').forEach((d) => d.classList.remove('open'));
  saveGame();
  $('btnContinue').hidden = !store.get('kitty.save', null);
  show('menu');
}
let confirmYes = null;
function confirmBox(text, yes) {
  $('confirmText').textContent = text;
  confirmYes = yes;
  openDlg('dlgConfirm');
}
$('confirmNo').onclick = () => closeDlg('dlgConfirm');
$('confirmYes').onclick = () => { closeDlg('dlgConfirm'); if (confirmYes) confirmYes(); };

// New game dialog
let pickSuits = prefs.suits;
function refreshSeg() {
  document.querySelectorAll('#suitSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.s === pickSuits));
  $('suitDesc').textContent = SUIT_DESC[pickSuits];
}
$('suitSeg').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) { pickSuits = +b.dataset.s; refreshSeg(); }
};
function askNewGame() {
  pickSuits = prefs.suits;
  $('optEmptyDeal').checked = prefs.allowEmptyDeal;
  refreshSeg();
  openDlg('dlgNew');
}
/** New Game button: confirm first if a game in progress would be thrown away. */
function requestNewGame() {
  const live = screen === 'game' ? S && started && !won : !!store.get('kitty.save', null);
  if (live) confirmBox('Abandon the current game and start a new one?', askNewGame);
  else askNewGame();
}
$('newCancel').onclick = () => { closeDlg('dlgNew'); if (screen === 'game' && won) showMenu(); };
$('newStart').onclick = () => {
  prefs.suits = pickSuits;
  prefs.allowEmptyDeal = $('optEmptyDeal').checked;
  savePrefs();
  document.querySelectorAll('.dlg.open').forEach((d) => d.classList.remove('open'));
  startGame(L.newGame(prefs.suits, prefs.allowEmptyDeal), true);
};

function startGame(state, freshBackground) {
  stopFx();
  S = state;
  initial = encode(S);
  history = [];
  elapsed = 0;
  started = false;
  won = false;
  if (freshBackground) newBackground();
  show('game');
  buildCards();
  clearHint();
  dealAnimation();
  saveGame();
}
function dealAnimation() {
  place({ instant: true, fromStock: true });
  void board.offsetWidth;
  const delays = new Map();
  let n = 0;
  for (let row = 0; row < 6; row++) {
    for (let c = 0; c < L.COLS; c++) if (S.cols[c][row]) delays.set(S.cols[c][row].id, n++ * 22);
  }
  lockUntil = performance.now() + n * 22 + MOVE_MS;
  place({ delays });
}
function resumeGame() {
  const sv = store.get('kitty.save', null);
  if (!sv) return;
  try {
    S = decode(sv.cur, sv.suits, sv.allow);
    history = sv.history || [];
    initial = sv.initial;
    elapsed = sv.elapsed || 0;
    started = !!sv.started;
    won = false;
  } catch {
    store.del('kitty.save');
    $('btnContinue').hidden = true;
    return;
  }
  show('game');
  buildCards();
  place({ instant: true });
}

$('btnNew').onclick = requestNewGame;
$('btnContinue').onclick = resumeGame;
$('cog').onclick = () => { if (won) return; clearHint(); $('menuStats').innerHTML = statsHtml(); openDlg('dlgMenu'); };
$('undo').onclick = doUndo;
$('hint').onclick = doHint;
$('mResume').onclick = () => closeDlg('dlgMenu');
$('mNew').onclick = requestNewGame;
$('mRestart').onclick = () => confirmBox('Restart this game from the beginning?', () => {
  closeDlg('dlgMenu');
  startGame(decode(initial, S.suits, S.allowEmptyDeal), false);
});
$('mQuit').onclick = showMenu;
$('wMenu').onclick = showMenu;
$('wNew').onclick = askNewGame;

// Quit button only exists where an app is allowed to close itself (Android).
if (native) {
  $('quitApp').hidden = false;
  $('quitApp').onclick = () => { saveGame(); cap.nativePromise('App', 'exitApp', {}); };
  try {
    cap.addListener('App', 'backButton', () => {
      const d = dlgOpen();
      if (d) {
        if (d.id === 'dlgWin') showMenu(); else d.classList.remove('open');
      } else if (screen === 'game') $('cog').onclick();
      else cap.nativePromise('App', 'exitApp', {});
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- timer
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  if (screen === 'game' && S && started && !won && !dlgOpen() && !document.hidden && dt < 3000) elapsed += dt;
}, 500);
document.addEventListener('visibilitychange', () => { if (document.hidden && screen === 'game') saveGame(); });
window.addEventListener('pagehide', () => { if (screen === 'game') saveGame(); });

let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { if (screen === 'game') place({ instant: true }); sizeFx(); });
});

// ---------------------------------------------------------------- win celebration
const fx = $('fx');
const ctx = fx.getContext('2d');
let fxRaf = 0, fxW = 0, fxH = 0;
function sizeFx() {
  if (fx.hidden) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fxW = window.innerWidth; fxH = window.innerHeight;
  fx.width = fxW * dpr; fx.height = fxH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function stopFx() {
  cancelAnimationFrame(fxRaf);
  fxRaf = 0;
  fx.hidden = true;
}
const SUIT_COLOR = ['#16181d', '#d3202f', '#0b7a3b', '#1a5fd0'];
function drawCard(x, y, w, h, id) {
  const r = w * 0.09;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
  ctx.fillStyle = '#fdfdfa';
  ctx.fill();
  ctx.strokeStyle = '#8f96a3';
  ctx.lineWidth = 1;
  ctx.stroke();
  const suit = L.suitOf(S, id);
  ctx.fillStyle = SUIT_COLOR[suit];
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = `800 ${w * 0.27}px system-ui, sans-serif`;
  ctx.fillText(RANKS[L.rankOf(id)] + SUIT_CH[suit], x + w * 0.07, y + h * 0.05);
  ctx.textAlign = 'center';
  ctx.font = `${w * 0.6}px system-ui, sans-serif`;
  ctx.fillText(SUIT_CH[suit], x + w / 2, y + h * 0.42);
}
function cascade() {
  fx.hidden = false;
  sizeFx();
  ctx.clearRect(0, 0, fxW, fxH);
  const w = Math.max(M.cw, 46), h = w * 1.4;
  const queue = [];
  for (let k = 0; k < 13; k++) for (let n = 0; n < 8; n++) queue.push(S.done[n][k]);
  const live = [];
  let frame = 0;
  const step = () => {
    if (frame++ % 9 === 0 && queue.length) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      live.push({ id: queue.shift(), x: Math.random() * (fxW - w), y: -h * Math.random() * 0.5, vx: dir * (1.5 + Math.random() * 3.5), vy: Math.random() * 2 });
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const c = live[i];
      c.vy += 0.5;
      c.x += c.vx;
      c.y += c.vy;
      if (c.y + h > fxH) { c.y = fxH - h; c.vy *= -0.8; }
      drawCard(c.x, c.y, w, h, c.id);
      if (c.x > fxW || c.x + w < 0) live.splice(i, 1);
    }
    fxRaf = queue.length || live.length ? requestAnimationFrame(step) : 0;
  };
  fxRaf = requestAnimationFrame(step);
}
function showWin() {
  if (!won || screen !== 'game') return;
  $('winStats').innerHTML = statsHtml();
  cascade();
  openDlg('dlgWin');
}

// ---------------------------------------------------------------- start-up
if (prefs.bg && BACKGROUNDS.includes(prefs.bg)) setBackground(prefs.bg, false);
else newBackground();
$('btnContinue').hidden = !store.get('kitty.save', null);

// Web / iPad home-screen version: store the whole game on the device for offline play.
if (!native && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.ready.then(() => { $('offline').hidden = false; });
}

// Handy for automated testing.
window.__kitty = { get state() { return S; }, L, place, startGame, decode, encode };
