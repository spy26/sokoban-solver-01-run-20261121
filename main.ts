// Sokoban solver — push-optimal, room by room.
//
// A level is a one-wide hallway with small rooms off it, one door each. A box
// pushed out of a room can never come back, so each room is an independent
// puzzle and the level optimum is the sum of the rooms' optima. Every room is
// solved push-optimally with A* over pushes: a state is the boxes plus the
// player's reachable region (named by its lowest square), the heuristic is the
// min-cost box-to-goal matching over precomputed walking distances, and dead
// squares plus frozen 2x2 blocks are pruned. The per-room push sequences are
// stitched together with shortest walks between doors.
//
// Deterministic: fixed iteration orders, fixed tie-breaks, no clock, no
// randomness. Pure TypeScript with erasable syntax only (node22
// type-stripping, run as `node main.ts`).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Search budget (states) for one room; rooms this generator draws stay far below it. */
const MAX_ROOM_STATES = 500_000;
/** Smaller budget for the whole-level fallback, which is only insurance. */
const MAX_LEVEL_STATES = 100_000;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
};

const DIRS: { dx: number; dy: number; letter: string }[] = [
  { dx: 0, dy: -1, letter: 'u' },
  { dx: 0, dy: 1, letter: 'd' },
  { dx: -1, dy: 0, letter: 'l' },
  { dx: 1, dy: 0, letter: 'r' },
];

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live squares: cells from which a box alone can still be pushed onto some
 * goal. Found by reverse pulls: from every live cell x, the box could have
 * come from y = x - d provided the player could have stood at y - d.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, h, wall, goals } = board;
  const live = new Uint8Array(w * h);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    const xx = x % w;
    const xy = (x / w) | 0;
    for (const d of DIRS) {
      const yx = xx - d.dx;
      const yy = xy - d.dy;
      const px = yx - d.dx;
      const py = yy - d.dy;
      if (yx < 0 || yy < 0 || yx >= w || yy >= h) continue;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const y = yy * w + yx;
      const p = py * w + px;
      if (wall[y] === 1 || wall[p] === 1 || live[y] === 1) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/**
 * Flood fill from `from` around walls and `occupied` boxes, marking `seen`
 * with `stamp`; returns the lowest reachable square (the region's name).
 */
function regionLow(
  board: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, h, wall } = board;
  let low = from;
  let sp = 0;
  stack[sp++] = from;
  seen[from] = stamp;
  while (sp > 0) {
    const p = stack[--sp]!;
    if (p < low) low = p;
    const px = p % w;
    const py = (p / w) | 0;
    for (const d of DIRS) {
      const nx = px + d.dx;
      const ny = py + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (wall[q] === 1 || occupied[q] === 1 || seen[q] === stamp) continue;
      seen[q] = stamp;
      stack[sp++] = q;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * wall-or-box squares holding a box off its goal. Such a box can never move
 * again, so the state is dead.
 */
function frozenBlock(
  wall: Uint8Array,
  occupied: Uint8Array,
  goalAt: Uint8Array,
  t: number,
  w: number,
  h: number,
): boolean {
  const tx = t % w;
  const ty = (t / w) | 0;
  for (let oy = ty - 1; oy <= ty; oy++) {
    for (let ox = tx - 1; ox <= tx; ox++) {
      let full = true;
      let offGoal = false;
      for (let k = 0; k < 4; k++) {
        const cx = ox + (k % 2);
        const cy = oy + ((k / 2) | 0);
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue; // outside the board is wall
        const c = cy * w + cx;
        if (wall[c] === 1) continue;
        if (occupied[c] === 1) {
          if (goalAt[c] === 0) offGoal = true;
          continue;
        }
        full = false;
        break;
      }
      if (full && offGoal) return true;
    }
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, in lower-case LURD. */
function walkPath(board: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, h, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const how = new Array<string>(w * h);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    const px = p % w;
    const py = (p / w) | 0;
    for (const d of DIRS) {
      const nx = px + d.dx;
      const ny = py + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (wall[q] === 1 || occupied[q] === 1 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return ''; // unreachable; the search never asks for this
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    if (ch === 'u') p -= w;
    else if (ch === 'd') p += w;
    else if (ch === 'l') p -= 1;
    else if (ch === 'r') p += 1;
  }
  return p;
}

/**
 * Push-optimal A* over a board: states are (sorted boxes, player region),
 * edges are single pushes, cost is pushes. The heuristic is the min-cost
 * matching of boxes to goals over precomputed walking distances (exact by
 * permutation for up to 4 boxes, sum of per-box minima beyond that) — each
 * push moves one box one square, so it never overestimates. Returns the push
 * count and the full move string, or null when the budget runs out or the
 * board is unsolvable.
 */
function pushSearch(board: Board, maxStates: number): { pushes: number; moves: string } | null {
  const { w, h, wall, goals, boxes: startBoxes, player: startPlayer } = board;
  const size = w * h;
  const goalAt = new Uint8Array(size);
  for (const g of goals) goalAt[g] = 1;
  const live = liveSquares(board);
  for (const b of startBoxes) if (live[b] === 0) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goalAt[b] === 1);
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  // Walking distance from each goal over floor alone (boxes ignored).
  const goalDist: Int32Array[] = goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    const queue: number[] = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      const px = p % w;
      const py = (p / w) | 0;
      for (const d of DIRS) {
        const nx = px + d.dx;
        const ny = py + d.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (wall[q] === 1 || dist[q] !== -1) continue;
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
    return dist;
  });

  // All goal permutations, for the exact min-cost matching (n <= 4).
  const n = startBoxes.length;
  const perms: number[][] = [];
  if (n >= 1 && n <= 4) {
    const base: number[] = [];
    for (let i = 0; i < n; i++) base.push(i);
    const gen = (arr: number[], k: number): void => {
      if (k === 1) {
        perms.push(arr.slice());
        return;
      }
      for (let i = 0; i < k; i++) {
        gen(arr, k - 1);
        const j = k % 2 === 1 ? 0 : i;
        const tmp = arr[j]!;
        arr[j] = arr[k - 1]!;
        arr[k - 1] = tmp;
      }
    };
    gen(base, n);
  }

  const heuristic = (bs: number[]): number => {
    if (perms.length > 0) {
      let best = Infinity;
      for (const p of perms) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = goalDist[p[i]!]![bs[i]!]!;
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let j = 0; j < goals.length; j++) {
        const d = goalDist[j]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  // More boxes than goals can never be solved — and the matching heuristic
  // below indexes goals by box, so bail out before it can throw.
  if (goals.length < startBoxes.length) return null;
  if (heuristic(startBoxes) === Infinity) return null;

  const seen = new Int32Array(size); // region stamps at expansion
  const mark = new Int32Array(size); // region stamps at state creation
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  let stamp = 0;

  // The states: boxes, player square, parent, and the push that made them.
  const sBoxes: number[][] = [];
  const sPlayer: number[] = [];
  const sParent: number[] = [];
  const sFrom: number[] = [];
  const sTo: number[] = [];
  const sDir: number[] = [];
  const sG: number[] = [];
  const sKey: string[] = [];
  const best = new Map<string, number>();

  // Binary heap on [f, g, seq, state]: lowest f first, deeper g first on ties,
  // insertion order last — fully deterministic.
  type HeapEntry = [number, number, number, number];
  const heap: HeapEntry[] = [];
  const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: HeapEntry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  for (const b of startBoxes) occupied[b] = 1;
  const low0 = regionLow(board, occupied, startPlayer, mark, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  const key0 = `${low0}:${startBoxes.join(',')}`;
  const h0 = heuristic(startBoxes);
  sBoxes.push(startBoxes.slice());
  sPlayer.push(startPlayer);
  sParent.push(-1);
  sFrom.push(-1);
  sTo.push(-1);
  sDir.push(-1);
  sG.push(0);
  sKey.push(key0);
  best.set(key0, 0);
  let seq = 0;
  heapPush([h0, 0, seq++, 0]);

  let found = -1;
  while (heap.length > 0) {
    const entry = heapPop();
    const g = entry[1];
    const s = entry[3];
    if (best.get(sKey[s]!) !== s) continue; // stale entry: a better path to this state exists
    const boxes = sBoxes[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(board, occupied, sPlayer[s]!, seen, here, stack);
    let outOfBudget = false;
    for (let bi = 0; bi < boxes.length && !outOfBudget; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const tx = bx + d.dx;
        const ty = by + d.dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const t = ty * w + tx;
        if (wall[t] === 1 || occupied[t] === 1 || live[t] === 0) continue;
        const px = bx - d.dx;
        const py = by - d.dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const pushFrom = py * w + px;
        if (seen[pushFrom] !== here) continue; // the player cannot reach the push square
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(wall, occupied, goalAt, t, w, h)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, bb) => a - bb);
        const low = regionLow(board, occupied, b, mark, ++stamp, stack);
        const key = `${low}:${next.join(',')}`;
        occupied[t] = 0;
        occupied[b] = 1;
        const prev = best.get(key);
        if (prev !== undefined && sG[prev]! <= g + 1) continue;
        const hh = heuristic(next);
        if (hh === Infinity) continue; // no matching left: dead end
        if (sBoxes.length >= maxStates) {
          outOfBudget = true;
          break;
        }
        const idx = sBoxes.length;
        best.set(key, idx);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(di);
        sG.push(g + 1);
        sKey.push(key);
        heapPush([g + 1 + hh, g + 1, seq++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
    if (outOfBudget) return null;
  }
  if (found < 0) return null;

  // Rebuild the push chain, then the moves: walk to each push square, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes.slice();
  for (const s of chain) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const di = sDir[s]!;
    const d = DIRS[di]!;
    for (const b of boxes) occupied[b] = 1;
    const target = from - (d.dy * w + d.dx);
    const walk = walkPath(board, occupied, player, target);
    if (walk === '' && player !== target) {
      // The push square is unreachable: never emit a broken solution.
      for (const b of boxes) occupied[b] = 0;
      return null;
    }
    moves += walk;
    for (const b of boxes) occupied[b] = 0;
    moves += d.letter;
    player = from;
    const bi = boxes.indexOf(from);
    boxes[bi] = to;
    boxes.sort((a, bb) => a - bb);
  }
  return { pushes: chain.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway —
 * a box there reaches no goal) out of the floor, and each remaining part
 * holding boxes is a room. Null when the level is no set of rooms.
 */
function splitRooms(board: Board): Room[] | null {
  const { w, h, wall, goals, boxes, player } = board;
  const live = liveSquares(board);
  const row = (player / w) | 0;
  const cut = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  for (const b of boxes) if (cut[b] === 1) return null;
  const comp = new Int32Array(w * h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] === 1 || cut[s] === 1 || comp[s] >= 0) continue;
    const squares: number[] = [s];
    comp[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      const px = p % w;
      const py = (p / w) | 0;
      for (const d of DIRS) {
        const nx = px + d.dx;
        const ny = py + d.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (wall[q] === 1 || cut[q] === 1 || comp[q] >= 0) continue;
        comp[q] = rooms.length;
        squares.push(q);
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[comp[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (comp[g]! < 0) return null;
    rooms[comp[g]!]!.goals.push(g);
  }
  for (const r of rooms) if (r.boxes.length !== r.goals.length) return null;
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  withBoxes.sort((a, b) => a.squares[0]! - b.squares[0]!);
  return withBoxes;
}

/** Whole-level push search: only insurance for levels that are no set of rooms. */
function wholeLevel(board: Board): string {
  const res = pushSearch(board, MAX_LEVEL_STATES);
  return res === null ? '' : res.moves;
}

/** Solve one level: room by room, the player walking on from room to room. */
function solveLevel(text: string): string {
  const board = parseLevel(text);
  const goalAt = new Uint8Array(board.w * board.h);
  for (const g of board.goals) goalAt[g] = 1;
  if (board.boxes.every((b) => goalAt[b] === 1)) return '';
  const rooms = splitRooms(board);
  if (rooms !== null) {
    let player = board.player;
    let moves = '';
    for (const room of rooms) {
      const wall = board.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const blockers = other.done ? other.goals : other.boxes;
        for (const b of blockers) wall[b] = 1;
      }
      const sub: Board = {
        w: board.w,
        h: board.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const res = pushSearch(sub, MAX_ROOM_STATES);
      if (res === null) return wholeLevel(board);
      moves += res.moves;
      player = endOf(board.w, player, res.moves);
      room.done = true;
    }
    return moves;
  }
  return wholeLevel(board);
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
