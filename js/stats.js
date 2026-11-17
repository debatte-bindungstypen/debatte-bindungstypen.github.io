// History, replay and end-of-debate statistics. Pure functions over a session:
//   session.events: [t(ms since start), playerIdx, x*1000, y*1000, kind]
//   kind: EV_MOVE (placed somewhere), EV_JOIN (appeared, not voted yet), EV_GONE (removed by host)

import { zoneOf } from './shared.js';

export const EV_MOVE = 0;
export const EV_JOIN = 1;
export const EV_GONE = 2;

/** Rebuilds everyone's position at any moment by replaying the event log. */
export class Replayer {
  constructor(session) {
    this.s = session;
    this.reset();
  }
  reset() {
    this.i = 0;
    this.T = -1;
    this.pos = []; // idx -> {x, y, placed} | null
  }
  seek(T) {
    if (T < this.T) this.reset();
    const ev = this.s.events;
    while (this.i < ev.length && ev[this.i][0] <= T) {
      const [, idx, x, y, k] = ev[this.i++];
      if (k === EV_GONE) {
        this.pos[idx] = null;
        continue;
      }
      const p = this.pos[idx] || (this.pos[idx] = { x: 0.5, y: 0.5, placed: false });
      p.x = x / 1000;
      p.y = y / 1000;
      if (k === EV_MOVE) p.placed = true;
    }
    this.T = T;
    return this.pos;
  }
}

export function tallyOf(items, neutral) {
  let a = 0, u = 0, b = 0;
  for (const p of items) {
    if (!p) continue;
    const z = zoneOf(p.x, neutral, p.placed);
    if (z < 0) a++;
    else if (z > 0) b++;
    else u++;
  }
  return { a, u, b, n: a + u + b };
}

/** Per-person numbers + awards for the results screen. */
export function computeStats(s, endT) {
  const neutral = s.cfg.neutral;
  const per = s.players.map((p, idx) => ({
    idx,
    pid: p.pid,
    name: p.name,
    bot: !!p.bot,
    joinT: null,
    firstSide: 0,
    finalZone: 0,
    finalX: 0.5,
    switches: 0,
    switchTimes: [],
    travel: 0,
    timeA: 0,
    timeU: 0,
    timeB: 0,
    timeIdle: 0,
    convSum: 0,
    convMs: 0,
    minX: 1,
    maxX: 0,
    placed: false,
    removed: false,
    track: [],
  }));
  const cur = [];
  const close = (r, c, t) => {
    const dt = Math.max(0, t - c.t);
    if (!c.placed) r.timeIdle += dt;
    else if (c.z < 0) r.timeA += dt;
    else if (c.z > 0) r.timeB += dt;
    else r.timeU += dt;
    if (c.placed) {
      r.convSum += dt * Math.abs(c.x - 0.5) * 2;
      r.convMs += dt;
    }
  };

  for (const [t, idx, xi, , k] of s.events) {
    if (t > endT) break;
    const r = per[idx];
    if (!r) continue;
    const c = cur[idx];
    if (c) close(r, c, t);
    if (k === EV_GONE) {
      r.removed = true;
      cur[idx] = null;
      continue;
    }
    const x = xi / 1000;
    if (r.joinT == null) r.joinT = t;
    const placed = !!(c && c.placed) || k === EV_MOVE;
    if (c && c.placed) r.travel += Math.abs(x - c.x);
    const z = zoneOf(x, neutral, placed);
    let committed = c ? c.committed : 0;
    if (z !== 0) {
      if (!r.firstSide) r.firstSide = z;
      if (committed && z !== committed) {
        r.switches++;
        r.switchTimes.push(t);
        r.lastSwitchTo = z;
      }
      committed = z;
    }
    if (placed) {
      r.placed = true;
      r.minX = Math.min(r.minX, x);
      r.maxX = Math.max(r.maxX, x);
      r.track.push([t, x]);
    }
    cur[idx] = { x, placed, t, committed, z };
  }
  for (const r of per) {
    const c = cur[r.idx];
    if (!c) continue;
    close(r, c, endT);
    r.finalX = c.x;
    r.finalZone = c.z;
  }
  for (const r of per) {
    r.conviction = r.convMs ? r.convSum / r.convMs : 0;
    r.swing = r.placed ? r.maxX - r.minX : 0;
    r.present = r.timeA + r.timeU + r.timeB + r.timeIdle;
    r.converted = !!(r.firstSide && r.finalZone && r.finalZone !== r.firstSide);
  }

  const people = per.filter((r) => !r.removed && r.joinT != null);
  const placed = people.filter((r) => r.placed);
  const best = (arr, score, min = -Infinity) => {
    let top = null, topS = min;
    for (const r of arr) {
      const v = score(r);
      if (v > topS) {
        top = r;
        topS = v;
      }
    }
    return top;
  };

  const opening = { a: 0, u: 0, b: 0 };
  const final = { a: 0, u: 0, b: 0 };
  for (const r of people) {
    opening[r.firstSide < 0 ? 'a' : r.firstSide > 0 ? 'b' : 'u']++;
    final[r.finalZone < 0 ? 'a' : r.finalZone > 0 ? 'b' : 'u']++;
  }

  let lastSwitch = null;
  for (const r of placed) {
    const t = r.switchTimes[r.switchTimes.length - 1];
    if (t != null && (!lastSwitch || t > lastSwitch.t)) lastSwitch = { r, t, to: r.lastSwitchTo };
  }
  const longEnough = endT * 0.25;

  const awards = {
    flipper: best(placed, (r) => r.switches * 1000 + r.travel, 999),
    journey: best(placed, (r) => r.travel, 0.05),
    swing: best(placed, (r) => r.swing, 0.05),
    rock: best(
      placed.filter((r) => r.switches === 0 && r.present >= longEnough),
      (r) => r.conviction,
      0
    ),
    fence: best(placed, (r) => r.timeU, 5000),
    late: lastSwitch,
    convertsAB: placed.filter((r) => r.converted && r.firstSide < 0),
    convertsBA: placed.filter((r) => r.converted && r.firstSide > 0),
  };

  return { per, people, opening, final, awards, endT };
}

/** Tally (a/u/b counts) recorded closest to time t. */
export function tallyAt(s, t) {
  const arr = s.tally;
  if (!arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  const [, a, u, b] = arr[lo];
  return { a, u, b, n: a + u + b };
}
