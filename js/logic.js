// Kitty Solitaire - game rules (no DOM in here, so it can be tested in Node).
//
// 104 cards = 8 sets of 13. A card id is 0..103:
//   set  = floor(id / 13)   rank = id % 13 + 1   (1 = Ace ... 13 = King)
// Which suit a set uses depends on the difficulty (number of suits).

export const COLS = 10;
export const SUIT_SETS = {
  1: [0, 0, 0, 0, 0, 0, 0, 0],
  2: [0, 1, 0, 1, 0, 1, 0, 1],
  3: [0, 1, 2, 0, 1, 2, 0, 1], // 3 spades, 3 hearts, 2 clubs
  4: [0, 1, 2, 3, 0, 1, 2, 3],
};
export const START_SCORE = 500;

export const rankOf = (id) => (id % 13) + 1;
export const suitOf = (state, id) => SUIT_SETS[state.suits][Math.floor(id / 13)];

export function newGame(suits = 3, allowEmptyDeal = false, rng = Math.random) {
  const deck = Array.from({ length: 104 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const cols = [];
  for (let c = 0; c < COLS; c++) {
    const n = c < 4 ? 6 : 5;
    const col = [];
    for (let k = 0; k < n; k++) col.push({ id: deck.pop(), up: k === n - 1 });
    cols.push(col);
  }
  return { suits, allowEmptyDeal, cols, stock: deck, done: [], moves: 0 };
}

export const score = (s) => Math.max(0, START_SCORE - s.moves + 100 * s.done.length);
export const isWon = (s) => s.done.length === 8;
export const dealsLeft = (s) => Math.floor(s.stock.length / COLS);

/** Index where the movable run at the bottom of a column starts (col.length if empty). */
export function movableStart(s, c) {
  const col = s.cols[c];
  if (!col.length) return 0;
  let i = col.length - 1;
  while (
    i > 0 &&
    col[i - 1].up &&
    suitOf(s, col[i - 1].id) === suitOf(s, col[i].id) &&
    rankOf(col[i - 1].id) === rankOf(col[i].id) + 1
  ) i--;
  return i;
}

export function canPickup(s, c, idx) {
  const col = s.cols[c];
  return idx >= 0 && idx < col.length && col[idx].up && idx >= movableStart(s, c);
}

export function canDrop(s, from, idx, to) {
  if (from === to || !canPickup(s, from, idx)) return false;
  const t = s.cols[to];
  if (!t.length) return true;
  return rankOf(t[t.length - 1].id) === rankOf(s.cols[from][idx].id) + 1;
}

function flipTop(s, c) {
  const col = s.cols[c];
  if (col.length && !col[col.length - 1].up) col[col.length - 1].up = true;
}

/** Removes any finished King->Ace same-suit run. Returns how many sets were completed. */
function collect(s) {
  let n = 0;
  for (let c = 0; c < COLS; c++) {
    const col = s.cols[c];
    if (col.length < 13) continue;
    const start = movableStart(s, c);
    if (col.length - start >= 13 && rankOf(col[col.length - 1].id) === 1 && rankOf(col[col.length - 13].id) === 13) {
      s.done.push(col.splice(col.length - 13, 13).map((k) => k.id));
      flipTop(s, c);
      n++;
    }
  }
  return n;
}

/** Moves the run starting at idx in column `from` onto column `to`. */
export function move(s, from, idx, to) {
  if (!canDrop(s, from, idx, to)) return null;
  const run = s.cols[from].splice(idx);
  s.cols[to].push(...run);
  flipTop(s, from);
  s.moves++;
  return { completed: collect(s) };
}

/** Why dealing is not possible right now, or null if it is. */
export function dealBlocked(s) {
  if (!s.stock.length) return 'empty';
  if (!s.allowEmptyDeal) {
    const onTable = s.cols.reduce((n, c) => n + c.length, 0);
    if (onTable >= COLS && s.cols.some((c) => !c.length)) return 'gap';
  }
  return null;
}

export function deal(s) {
  if (dealBlocked(s)) return null;
  const dealt = [];
  for (let c = 0; c < COLS && s.stock.length; c++) {
    const id = s.stock.pop();
    s.cols[c].push({ id, up: true });
    dealt.push(id);
  }
  s.moves++;
  return { dealt, completed: collect(s) };
}

function runLenAtBottom(s, c) {
  return s.cols[c].length - movableStart(s, c);
}

/** All sensible moves, each with a score (higher = better). `relaxed` also allows run-breaking moves to empty columns. */
export function listMoves(s, relaxed = false) {
  const out = [];
  for (let from = 0; from < COLS; from++) {
    const col = s.cols[from];
    if (!col.length) continue;
    const start = movableStart(s, from);
    for (let idx = start; idx < col.length; idx++) {
      const card = col[idx];
      const len = col.length - idx;
      const below = idx > 0 ? col[idx - 1] : null;
      const reveals = !!below && !below.up;
      const empties = idx === 0;
      const breaks = idx > start;
      const onParent = !!below && below.up && rankOf(below.id) === rankOf(card.id) + 1;
      for (let to = 0; to < COLS; to++) {
        if (to === from) continue;
        const t = s.cols[to];
        let sc;
        if (!t.length) {
          if (empties) continue; // moving a whole column to an empty one does nothing
          if (breaks && !relaxed) continue;
          sc = reveals ? 40 : onParent ? 2 : 10;
          if (breaks) sc = 1;
        } else {
          const top = t[t.length - 1];
          if (rankOf(top.id) !== rankOf(card.id) + 1) continue;
          const same = suitOf(s, top.id) === suitOf(s, card.id);
          if (same) {
            const newLen = runLenAtBottom(s, to) + len;
            if (breaks && newLen <= col.length - start) continue; // would not make a longer run
            sc = 100 + newLen + (reveals ? 30 : 0) + (empties ? 25 : 0);
          } else {
            if (breaks || onParent) continue; // pointless shuffle
            sc = 40 + (reveals ? 30 : 0) + (empties ? 35 : 0) + len;
          }
        }
        out.push({ from, idx, to, score: sc });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** { type:'move', from, idx, to } | { type:'deal' } | null (stuck) */
export function hint(s) {
  let moves = listMoves(s);
  // Low-value moves only matter when there is nothing better and no stock to deal.
  const good = moves.filter((m) => m.score > 2);
  if (good.length) return { type: 'move', ...good[0] };
  const blocked = dealBlocked(s);
  if (!blocked) return { type: 'deal' };
  if (moves.length) return { type: 'move', ...moves[0] };
  if (blocked === 'gap') {
    moves = listMoves(s, true);
    if (moves.length) return { type: 'move', ...moves[0] };
  }
  return null;
}

/** Best column to send a tapped run to, or -1. */
export function autoTarget(s, from, idx) {
  if (!canPickup(s, from, idx)) return -1;
  const card = s.cols[from][idx];
  let best = -1;
  let bestScore = -1;
  for (let to = 0; to < COLS; to++) {
    if (!canDrop(s, from, idx, to)) continue;
    const t = s.cols[to];
    let sc;
    if (!t.length) {
      if (idx === 0) continue;
      sc = 1;
    } else {
      const same = suitOf(s, t[t.length - 1].id) === suitOf(s, card.id);
      sc = same ? 100 + runLenAtBottom(s, to) : 10 + runLenAtBottom(s, to);
    }
    if (sc > bestScore) { bestScore = sc; best = to; }
  }
  return best;
}

export const clone = (s) => JSON.parse(JSON.stringify(s));
