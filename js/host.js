// Big screen: the room. Owns the session, records history, renders the floor.

/* global qrcode */
import { makeCode, zoneOf, clamp01, cleanName, fmtTime, store, cssVar, hexA, keepAwake, fitCanvas, dpr, makeId, NEUTRAL_HALF } from './shared.js';
import { HostNet } from './net.js';
import { Replayer, computeStats, tallyOf, tallyAt, EV_MOVE, EV_JOIN, EV_GONE } from './stats.js';

const $ = (id) => document.getElementById(id);
const FONT = getComputedStyle(document.body).fontFamily;

const DEFAULT_CFG = {
  q: 'Which side are you on?',
  a: 'Agree',
  b: 'Disagree',
  neutral: true,
  locked: false,
  crowd: true,
  names: true,
  heat: true,
  chip: true,
  theme: 'dark',
};
const REC_MIN = 250; // ms between recorded positions per person
const AWAY_MS = 15000; // no message for this long -> shown faded
const SAVE_KEY = 'df:host:session';
const BOT_NAMES = ['Ada', 'Ben', 'Cleo', 'Dario', 'Ema', 'Finn', 'Gala', 'Hugo', 'Ines', 'Jonas', 'Kira', 'Luka', 'Mila', 'Nico', 'Olga', 'Pia', 'Quentin', 'Rosa', 'Sven', 'Tara', 'Uma', 'Vera', 'Wim', 'Xenia', 'Yusuf', 'Zoe'];

let S = null; // the session — everything here is saved / exported
const live = new Map(); // pid -> runtime player
const byIdx = []; // idx -> runtime player
const cidToPid = new Map();
const bots = new Map();
let net = null;
let mode = 'live'; // 'live' | 'replay' | 'archive'
let replay = null; // { rep, T, playing, speed }
let replaySpeed = 10;
let focusIdx = -1;
let dirty = false;
let saveWarned = false;
let C = {};
let lastItems = [];
const rs = []; // smoothed render positions per idx

const now = () => Date.now() - S.startedAt;

/* =========================================================================
   Session
   ========================================================================= */

function newSession(code) {
  const remembered = store.get('df:cfg') || {};
  return {
    v: 1,
    code,
    startedAt: Date.now(),
    endedAt: null,
    cfg: { ...DEFAULT_CFG, ...remembered, locked: false },
    players: [], // [{pid, name, bot?}]
    events: [], // [t, idx, x*1000, y*1000, kind]
    marks: [], // [{t, label}]
    tally: [], // [t, a, u, b] once per second
    banned: [],
  };
}

function validSession(s) {
  return s && typeof s === 'object' && typeof s.code === 'string' && Array.isArray(s.players) && Array.isArray(s.events) && Array.isArray(s.tally) && s.cfg && typeof s.startedAt === 'number';
}

/** Rebuild runtime players from the event log (after reload / import). */
function hydrate() {
  live.clear();
  byIdx.length = 0;
  rs.length = 0;
  bots.clear();
  S.marks ||= [];
  S.banned ||= [];
  S.cfg = { ...DEFAULT_CFG, ...S.cfg };
  const pos = new Replayer(S).seek(Infinity);
  S.players.forEach((pl, idx) => {
    const q = pos[idx];
    const p = {
      pid: pl.pid,
      idx,
      name: pl.name,
      bot: !!pl.bot,
      x: q ? q.x : 0.5,
      y: q ? q.y : 0.5,
      placed: !!q?.placed,
      removed: !q,
      cid: null,
      lastSeen: 0,
      lastRecT: -1e9,
      dirty: false,
      born: 0,
    };
    live.set(p.pid, p);
    byIdx[idx] = p;
    if (p.bot && !p.removed && mode === 'live') bots.set(p.pid, newBotBrain());
  });
}

function record(p, kind) {
  const t = now();
  S.events.push([t, p.idx, Math.round(p.x * 1000), Math.round(p.y * 1000), kind]);
  p.lastRecT = t;
  p.dirty = false;
  dirty = true;
}

function addPlayer(pid, name, bot = false) {
  const idx = S.players.length;
  S.players.push(bot ? { pid, name, bot: true } : { pid, name });
  const p = {
    pid,
    idx,
    name,
    bot,
    x: 0.5 + (Math.random() - 0.5) * 0.04,
    y: 0.12 + Math.random() * 0.76,
    placed: false,
    removed: false,
    cid: null,
    lastSeen: Date.now(),
    lastRecT: -1e9,
    dirty: false,
    born: performance.now(),
  };
  live.set(pid, p);
  byIdx[idx] = p;
  record(p, EV_JOIN);
  updateJoinOverlay();
  return p;
}

function applyPos(p, x, y) {
  if (p.removed) return;
  if (p.placed && Math.abs(p.x - x) < 1e-4 && Math.abs(p.y - y) < 1e-4) return;
  const first = !p.placed;
  p.x = x;
  p.y = y;
  p.placed = true;
  if (first || now() - p.lastRecT >= REC_MIN) record(p, EV_MOVE);
  else p.dirty = true;
}

function removePlayer(p) {
  if (p.removed) return;
  p.removed = true;
  if (!p.bot) S.banned.push(p.pid);
  record(p, EV_GONE);
  bots.delete(p.pid);
  if (p.cid && net) {
    const cid = p.cid;
    net.send(cid, { t: 'kicked' });
    cidToPid.delete(cid);
    setTimeout(() => net?.close(cid), 400);
  }
  p.cid = null;
  if (focusIdx === p.idx) focusIdx = -1;
  updateJoinOverlay();
}

function activePlayers() {
  return byIdx.filter((p) => p && !p.removed);
}

function save() {
  if (mode === 'archive' || !S) return;
  S.savedAt = Date.now();
  const ok = store.set(SAVE_KEY, S);
  dirty = false;
  if (!ok && !saveWarned) {
    saveWarned = true;
    toast('Autosave is full — use “Save session file” in Settings to keep your data.', 6000);
  }
}

/* =========================================================================
   Network
   ========================================================================= */

let renamed = 0;
function startNet(isResume) {
  net?.destroy();
  cidToPid.clear();
  for (const p of byIdx) if (p) p.cid = null;
  net = new HostNet(S.code, {
    onStatus: setStatus,
    onError: (e) => {
      if (e === 'taken') {
        if (!isResume && S.events.length === 0 && renamed < 6) {
          // Brand-new room whose code happens to be in use: just pick another.
          renamed++;
          net.destroy();
          S.code = makeCode();
          renderJoinInfo();
          startNet(false);
        } else {
          setStatus('taken'); // HostNet keeps retrying the same code
        }
      } else if (e === 'browser') {
        setStatus('nowebrtc');
      }
    },
    onMessage: handleMsg,
    onDisconnect: (cid) => {
      const pid = cidToPid.get(cid);
      cidToPid.delete(cid);
      const p = pid && live.get(pid);
      if (p && p.cid === cid) p.cid = null;
    },
  }, { resume: isResume });
  net.start();
}

let netStatus = 'starting';
function setStatus(s) {
  netStatus = s;
  renderStatus();
}
function renderStatus() {
  const dot = $('statusDot');
  const txt = $('statusText');
  if (mode === 'archive') {
    dot.className = 'dot-status';
    txt.textContent = 'Saved session · not live';
    return;
  }
  const conn = net ? net.size : 0;
  const map = {
    online: [net?.degraded ? 'warn' : 'ok', `Live · room ${S.code} · ${conn} phone${conn === 1 ? '' : 's'} connected${net?.note || ''}`],
    denied: ['bad', 'The database refused access — check the Firebase rules (see README)'],
    reconnecting: ['warn', `Reconnecting… phones already in keep working`],
    taken: ['warn', `Waiting for room ${S.code} to free up (is it open in another tab?)`],
    nowebrtc: ['bad', 'This browser cannot host a room (no WebRTC)'],
    starting: ['warn', 'Opening room…'],
  };
  const [cls, t] = map[netStatus] || ['warn', netStatus];
  dot.className = 'dot-status ' + cls;
  txt.textContent = t;
}

function phoneCfg() {
  const c = S.cfg;
  return { q: c.q, a: c.a, b: c.b, neutral: c.neutral, locked: c.locked, crowd: c.crowd };
}

let cfgTimer = null;
function broadcastCfg() {
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => {
    for (const cid of cidToPid.keys()) net?.send(cid, { t: 'cfg', cfg: phoneCfg() });
  }, 250);
}

function handleMsg(cid, m) {
  if (!m || typeof m !== 'object' || mode === 'archive') return;
  if (m.t === 'hello') return onHello(cid, m);
  const pid = cidToPid.get(cid);
  const p = pid && live.get(pid);
  if (!p || p.removed) return;
  p.lastSeen = Date.now();
  if (m.t === 'pos' && !S.cfg.locked) applyPos(p, clamp01(m.x), clamp01(m.y));
}

function onHello(cid, m) {
  const pid = String(m.pid || '').slice(0, 40);
  if (!pid || pid.startsWith('bot-')) return;
  if (S.banned.includes(pid)) {
    net.send(cid, { t: 'kicked' });
    return;
  }
  const name = cleanName(m.name) || 'Guest';
  let p = live.get(pid);
  if (!p) p = addPlayer(pid, name);
  else if (p.name !== name) {
    p.name = name;
    S.players[p.idx].name = name;
    dirty = true;
    updateJoinOverlay();
  }
  if (p.removed) {
    net.send(cid, { t: 'kicked' });
    return;
  }
  if (p.cid && p.cid !== cid) {
    const old = p.cid;
    net.send(old, { t: 'replaced' });
    cidToPid.delete(old);
    setTimeout(() => net?.close(old), 400);
  }
  p.cid = cid;
  p.lastSeen = Date.now();
  cidToPid.set(cid, pid);
  // The phone is the source of truth for its own position (it may have moved while offline).
  if (m.placed && !S.cfg.locked) applyPos(p, clamp01(m.x), clamp01(m.y));
  net.send(cid, { t: 'welcome', you: { x: p.x, y: p.y, placed: p.placed }, cfg: phoneCfg() });
}

/* =========================================================================
   Ticks
   ========================================================================= */

function flushTick() {
  if (mode === 'archive') return;
  const t = now();
  for (const p of byIdx) if (p && p.dirty && t - p.lastRecT >= REC_MIN) record(p, EV_MOVE);
}

function secondTick() {
  if (mode === 'archive') return;
  const list = activePlayers();
  const d = [];
  const index = new Map();
  let a = 0, u = 0, b = 0;
  list.forEach((p, j) => {
    const z = zoneOf(p.x, S.cfg.neutral, p.placed);
    d.push(Math.round(p.x * 255), Math.round(p.y * 255), z < 0 ? 0 : z > 0 ? 2 : 1);
    index.set(p.pid, j);
    if (z < 0) a++;
    else if (z > 0) b++;
    else u++;
  });
  S.tally.push([now(), a, u, b]);
  dirty = true;
  const show = S.cfg.crowd;
  const tally = { a, u, b, n: a + u + b };
  for (const [cid, pid] of cidToPid) {
    net?.send(cid, { t: 'crowd', d: show ? d : null, me: index.get(pid) ?? -1, tally: show ? tally : null });
  }
  renderStatus();
  if (mode === 'live') $('clock').textContent = fmtTime(now());
}

/* ---- test people for rehearsals ---- */
function newBotBrain() {
  return { lean: (Math.random() - 0.5) * 1.4, tx: null, ty: null, wait: Math.random() * 3000 };
}
let botCount = 0;
function addBots(n) {
  if (mode === 'archive') return;
  for (let i = 0; i < n; i++) {
    const base = BOT_NAMES[botCount % BOT_NAMES.length];
    const round = Math.floor(botCount / BOT_NAMES.length);
    botCount++;
    const p = addPlayer('bot-' + makeId(), round ? `${base} ${round + 1}` : base, true);
    bots.set(p.pid, newBotBrain());
  }
  toast(`Added ${n} test people — they wander on their own`);
}
function botTick(dt) {
  if (mode === 'archive' || S.cfg.locked) return;
  const tide = Math.sin(now() / 45000) * 0.7;
  for (const [pid, b] of bots) {
    const p = live.get(pid);
    if (!p || p.removed) {
      bots.delete(pid);
      continue;
    }
    b.wait -= dt;
    if (b.tx == null || (b.wait <= 0 && Math.random() < 0.08)) {
      const pref = b.lean + tide + (Math.random() - 0.5) * 1.2;
      b.tx = pref < -0.25 ? 0.05 + Math.random() * 0.36 : pref > 0.25 ? 0.59 + Math.random() * 0.36 : 0.46 + Math.random() * 0.08;
      b.ty = 0.08 + Math.random() * 0.84;
      b.wait = 2500 + Math.random() * 9000;
    }
    const dx = b.tx - p.x, dy = b.ty - p.y, dist = Math.hypot(dx, dy);
    if (dist > 0.004) {
      const step = Math.min(dist, 0.014);
      applyPos(p, p.x + (dx / dist) * step, p.y + (dy / dist) * step);
    }
  }
}

/* =========================================================================
   Rendering — floor
   ========================================================================= */

const floor = $('floor');
const fctx = floor.getContext('2d');
const heat = document.createElement('canvas');
const hctx = heat.getContext('2d');
let heatAt = 0;

function readColors() {
  C = {
    a: cssVar('--a'),
    b: cssVar('--b'),
    u: cssVar('--u'),
    text: cssVar('--text'),
    muted: cssVar('--muted'),
    panel: cssVar('--panel'),
    line: cssVar('--line'),
    light: document.documentElement.dataset.theme === 'light',
  };
  tlKey = '';
}

function endT() {
  if (mode === 'archive') {
    const lt = S.tally.length ? S.tally[S.tally.length - 1][0] : 0;
    const le = S.events.length ? S.events[S.events.length - 1][0] : 0;
    return Math.max(lt, le, S.endedAt ? S.endedAt - S.startedAt : 0, 1000);
  }
  return Math.max(now(), 1000);
}

function currentItems() {
  const out = [];
  if (mode === 'live') {
    const t = Date.now();
    for (const p of byIdx) {
      if (!p || p.removed) continue;
      out.push({ idx: p.idx, x: p.x, y: p.y, placed: p.placed, name: p.name, away: !p.bot && (!p.cid || t - p.lastSeen > AWAY_MS), born: p.born });
    }
  } else {
    const pos = replay.rep.seek(replay.T);
    pos.forEach((q, idx) => {
      if (q) out.push({ idx, x: q.x, y: q.y, placed: q.placed, name: S.players[idx]?.name || '?', away: false, born: 0 });
    });
  }
  return out;
}

function fillTextFit(ctx, text, x, y, maxW) {
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(maxW / w, maxW / w);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  } else ctx.fillText(text, x, y);
}

function renderHeat(items) {
  const w = 220;
  const h = Math.max(30, Math.round((w * floor.height) / floor.width));
  if (heat.width !== w || heat.height !== h) {
    heat.width = w;
    heat.height = h;
  }
  hctx.clearRect(0, 0, w, h);
  const r = w * 0.085;
  const alpha = C.light ? 0.2 : 0.24;
  for (const it of items) {
    if (!it.placed) continue;
    const x = it.rx * w, y = it.ry * h;
    const col = it.rz < 0 ? C.a : it.rz > 0 ? C.b : C.u;
    const g = hctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(col, alpha));
    g.addColorStop(1, hexA(col, 0));
    hctx.fillStyle = g;
    hctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

let trackCache = { idx: -1, len: -1, pts: [] };
function focusTrack() {
  if (trackCache.idx !== focusIdx || trackCache.len !== S.events.length) {
    const pts = [];
    for (const e of S.events) if (e[1] === focusIdx && e[4] === EV_MOVE) pts.push([e[0], e[2] / 1000, e[3] / 1000]);
    trackCache = { idx: focusIdx, len: S.events.length, pts };
  }
  return trackCache.pts;
}

function drawFloor(items, ts) {
  fitCanvas(floor);
  const W = floor.width, H = floor.height, k = dpr();
  const ctx = fctx;
  ctx.clearRect(0, 0, W, H);
  const nx = S.cfg.neutral ? NEUTRAL_HALF : 0;
  const sideA = C.light ? 0.08 : 0.1;

  ctx.fillStyle = hexA(C.a, sideA);
  ctx.fillRect(0, 0, W * (0.5 - nx), H);
  ctx.fillStyle = hexA(C.b, sideA);
  ctx.fillRect(W * (0.5 + nx), 0, W * (0.5 - nx) + 1, H);
  if (nx) {
    ctx.fillStyle = hexA(C.u, 0.06);
    ctx.fillRect(W * (0.5 - nx), 0, W * nx * 2, H);
  }

  // side names as big watermarks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const wm = Math.min(H * 0.2, W * 0.075);
  ctx.font = `800 ${wm}px ${FONT}`;
  const halfW = W * (0.5 - nx);
  ctx.fillStyle = hexA(C.a, C.light ? 0.16 : 0.14);
  fillTextFit(ctx, S.cfg.a, halfW / 2, H / 2, halfW * 0.85);
  ctx.fillStyle = hexA(C.b, C.light ? 0.16 : 0.14);
  fillTextFit(ctx, S.cfg.b, W - halfW / 2, H / 2, halfW * 0.85);
  if (nx) {
    ctx.font = `700 ${11 * k}px ${FONT}`;
    ctx.fillStyle = hexA(C.u, 0.7);
    ctx.textBaseline = 'top';
    fillTextFit(ctx, 'UNDECIDED', W / 2, 12 * k, W * nx * 1.8);
  }

  ctx.save();
  ctx.strokeStyle = hexA(C.u, 0.45);
  ctx.setLineDash([8 * k, 8 * k]);
  ctx.lineWidth = 1.5 * k;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.restore();

  if (S.cfg.heat && items.length) {
    if (ts - heatAt > 110) {
      renderHeat(items);
      heatAt = ts;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(heat, 0, 0, W, H);
  }

  const n = items.length;
  const R = Math.max(5 * k, Math.min(13 * k, W * (n > 120 ? 0.0055 : n > 50 ? 0.0075 : 0.0095)));
  const focusing = focusIdx >= 0;

  // focused person's path
  if (focusing) {
    const T = mode === 'live' ? Infinity : replay.T;
    const pts = focusTrack().filter((p) => p[0] <= T);
    if (pts.length) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = hexA(C.text, 0.75);
      ctx.lineWidth = 2.5 * k;
      ctx.setLineDash([2 * k, 6 * k]);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[1] * W, p[2] * H) : ctx.moveTo(p[1] * W, p[2] * H)));
      const cur = rs[focusIdx];
      if (cur) ctx.lineTo(cur.x * W, cur.y * H);
      ctx.stroke();
      ctx.setLineDash([]);
      const [, sx, sy] = pts[0];
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.arc(sx * W, sy * H, R * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = `700 ${11 * k}px ${FONT}`;
      ctx.fillStyle = C.text;
      ctx.textBaseline = 'bottom';
      ctx.fillText('start', sx * W, sy * H - R - 2 * k);
      ctx.restore();
    }
  }

  // dots
  for (const it of items) {
    const x = it.rx * W, y = it.ry * H;
    const col = it.rz < 0 ? C.a : it.rz > 0 ? C.b : C.u;
    let alpha = it.away ? 0.35 : 1;
    if (focusing && it.idx !== focusIdx) alpha *= 0.3;
    ctx.globalAlpha = alpha;
    if (it.born && ts - it.born < 1400) {
      const p = (ts - it.born) / 1400;
      ctx.strokeStyle = hexA(col, 1 - p);
      ctx.lineWidth = 3 * k;
      ctx.beginPath();
      ctx.arc(x, y, R + p * 46 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    const big = it.idx === focusIdx ? 1.6 : 1;
    ctx.beginPath();
    ctx.arc(x, y, R * big, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = C.light ? '#fff' : hexA('#ffffff', 0.85);
    ctx.stroke();
  }

  // names
  if (S.cfg.names || focusing) {
    const fs = Math.max(11, Math.min(17, W / k / (n > 60 ? 140 : 110))) * k;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    for (const it of items) {
      const isF = it.idx === focusIdx;
      if (!S.cfg.names && !isF) continue;
      let alpha = it.away ? 0.4 : 1;
      if (focusing && !isF) alpha *= 0.3;
      ctx.globalAlpha = alpha;
      ctx.font = `${isF ? 800 : 600} ${isF ? fs * 1.35 : fs}px ${FONT}`;
      const x = it.rx * W, y = it.ry * H + R * (isF ? 1.6 : 1) + 3 * k;
      ctx.lineWidth = 4 * k;
      ctx.strokeStyle = C.panel;
      ctx.strokeText(it.name, x, y);
      ctx.fillStyle = C.text;
      ctx.fillText(it.name, x, y);
    }
  }
  ctx.globalAlpha = 1;
}

/* =========================================================================
   Rendering — tally + timeline
   ========================================================================= */

function updateTally(items) {
  const t = tallyOf(items, S.cfg.neutral);
  const n = t.n;
  const pa = n ? t.a / n : 0, pu = n ? t.u / n : 0, pb = n ? t.b / n : 0;
  $('segA').style.flexBasis = pa * 100 + '%';
  $('segU').style.flexBasis = (n ? pu * 100 : 100) + '%';
  $('segB').style.flexBasis = pb * 100 + '%';
  $('pctA').textContent = n ? Math.round(pa * 100) + '%' : '–';
  $('pctB').textContent = n ? Math.round(pb * 100) + '%' : '–';
  $('subU').textContent = !n ? '' : S.cfg.neutral ? `${Math.round(pu * 100)}% undecided` : t.u ? `${t.u} not placed yet` : '';
  $('subN').textContent = `${n} ${n === 1 ? 'person' : 'people'}`;
  $('floorHint').hidden = n > 0 || mode !== 'live';
}

const tl = $('timeline');
const tctx = tl.getContext('2d');
const tlCache = document.createElement('canvas');
let tlKey = '';

function drawTimeline() {
  fitCanvas(tl);
  const W = tl.width, H = tl.height, k = dpr();
  const end = endT();
  const key = `${W}x${H}|${S.tally.length}|${Math.round(end / 1000)}|${S.marks.length}|${S.cfg.neutral}|${S.cfg.a}|${S.cfg.b}`;
  if (key !== tlKey) {
    tlKey = key;
    renderTimelineCache(W, H, k, end);
  }
  tctx.clearRect(0, 0, W, H);
  tctx.drawImage(tlCache, 0, 0);
  if (mode !== 'live' && replay) {
    const x = Math.min(W - 1, (replay.T / end) * W);
    tctx.fillStyle = hexA(C.text, 0.1);
    tctx.fillRect(x, 0, W - x, H);
    tctx.fillStyle = C.text;
    tctx.fillRect(x - 1.5 * k, 0, 3 * k, H);
    tctx.beginPath();
    tctx.arc(x, 6 * k, 6 * k, 0, Math.PI * 2);
    tctx.fill();
  }
}

function renderTimelineCache(W, H, k, end) {
  tlCache.width = W;
  tlCache.height = H;
  const c = tlCache.getContext('2d');
  const arr = S.tally;
  c.font = `600 ${11 * k}px ${FONT}`;
  if (!arr.length) {
    c.fillStyle = C.muted;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('The opinion timeline builds up here as people join', W / 2, H / 2);
    return;
  }
  const step = Math.max(1, Math.floor(arr.length / (W / (2 * k))));
  const pts = [];
  for (let i = 0; i < arr.length; i += step) pts.push(arr[i]);
  if (pts[pts.length - 1] !== arr[arr.length - 1]) pts.push(arr[arr.length - 1]);
  const X = (t) => (t / end) * W;
  const fr = (p) => {
    const n = p[1] + p[2] + p[3];
    return n ? [p[1] / n, p[2] / n, p[3] / n] : [0, 0, 0];
  };

  // undecided = whatever is left between the two bands
  c.fillStyle = hexA(C.u, 0.22);
  c.fillRect(X(pts[0][0]), 0, X(pts[pts.length - 1][0]) - X(pts[0][0]), H);

  // A from the top
  c.fillStyle = hexA(C.a, 0.9);
  c.beginPath();
  c.moveTo(X(pts[0][0]), 0);
  pts.forEach((p) => c.lineTo(X(p[0]), fr(p)[0] * H));
  c.lineTo(X(pts[pts.length - 1][0]), 0);
  c.closePath();
  c.fill();

  // B from the bottom
  c.fillStyle = hexA(C.b, 0.9);
  c.beginPath();
  c.moveTo(X(pts[0][0]), H);
  pts.forEach((p) => c.lineTo(X(p[0]), H - fr(p)[2] * H));
  c.lineTo(X(pts[pts.length - 1][0]), H);
  c.closePath();
  c.fill();

  // 50% line
  c.strokeStyle = hexA(C.text, 0.35);
  c.setLineDash([4 * k, 5 * k]);
  c.lineWidth = 1 * k;
  c.beginPath();
  c.moveTo(0, H / 2);
  c.lineTo(W, H / 2);
  c.stroke();
  c.setLineDash([]);

  // side labels
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.font = `700 ${11 * k}px ${FONT}`;
  c.lineWidth = 3 * k;
  c.strokeStyle = C.panel;
  c.fillStyle = C.text;
  c.strokeText(S.cfg.a, 8 * k, 6 * k);
  c.fillText(S.cfg.a, 8 * k, 6 * k);
  c.textBaseline = 'bottom';
  c.strokeText(S.cfg.b, 8 * k, H - 6 * k);
  c.fillText(S.cfg.b, 8 * k, H - 6 * k);

  // marks
  c.textBaseline = 'top';
  for (const m of S.marks) {
    const x = X(m.t);
    c.fillStyle = C.text;
    c.fillRect(x - 1 * k, 0, 2 * k, H);
    c.font = `700 ${11 * k}px ${FONT}`;
    const tw = c.measureText(m.label).width;
    const lx = Math.min(x + 4 * k, W - tw - 10 * k);
    c.fillStyle = C.text;
    c.beginPath();
    c.roundRect ? c.roundRect(lx, 4 * k, tw + 10 * k, 17 * k, 5 * k) : c.rect(lx, 4 * k, tw + 10 * k, 17 * k);
    c.fill();
    c.fillStyle = C.panel;
    c.fillText(m.label, lx + 5 * k, 7 * k);
  }
}

/* =========================================================================
   Frame loop
   ========================================================================= */

let lastTs = performance.now();
let tallyTs = 0;
function frame(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;

  if (mode !== 'live' && replay?.playing) {
    replay.T += dt * 1000 * replay.speed;
    const end = endT();
    if (replay.T >= end) {
      replay.T = end;
      replay.playing = false;
      if (mode === 'replay') {
        exitReplay();
        toast('Replay finished — back to live');
      }
      updatePlayBtn();
    }
  }

  const items = currentItems();
  const kk = 1 - Math.exp(-dt * 9);
  for (const it of items) {
    let r = rs[it.idx];
    if (!r) r = rs[it.idx] = { x: it.x, y: it.y };
    r.x += (it.x - r.x) * kk;
    r.y += (it.y - r.y) * kk;
    it.rx = r.x;
    it.ry = r.y;
    it.rz = zoneOf(r.x, S.cfg.neutral, it.placed);
  }
  lastItems = items;
  drawFloor(items, ts);

  if (ts - tallyTs > 200) {
    tallyTs = ts;
    updateTally(items);
    if (mode !== 'live' && replay) $('clock').textContent = `${fmtTime(replay.T)} / ${fmtTime(endT())}`;
  }
  drawTimeline();
  requestAnimationFrame(frame);
}

/* =========================================================================
   Replay
   ========================================================================= */

function enterReplay(T = 0, play = true) {
  closeDotPop();
  if (mode === 'live') {
    mode = 'replay';
    replay = { rep: new Replayer(S), T, playing: play, speed: replaySpeed };
  } else {
    replay.T = T;
    replay.playing = play;
  }
  syncModeUI();
}

function exitReplay() {
  if (mode !== 'replay') return;
  mode = 'live';
  replay = null;
  syncModeUI();
}

function updatePlayBtn() {
  $('btnPlay').textContent = replay?.playing ? 'Pause' : 'Play';
}

function syncModeUI() {
  const rep = mode !== 'live';
  $('liveCtl').hidden = rep;
  $('replayCtl').hidden = !rep;
  $('btnExitReplay').textContent = mode === 'archive' ? 'Start a live room' : 'Back to live';
  const badge = $('modeBadge');
  badge.hidden = !(rep || S.cfg.locked);
  badge.className = 'badge' + (!rep && S.cfg.locked ? ' locked' : '');
  badge.textContent = mode === 'archive' ? 'Saved session' : rep ? 'Replay' : 'Voting locked';
  $('btnLock').querySelector('span').textContent = S.cfg.locked ? 'Unlock voting' : 'Lock voting';
  $('btnLock').classList.toggle('on', S.cfg.locked);
  $('btnMark').disabled = mode === 'archive';
  updatePlayBtn();
  renderStatus();
  if (mode === 'live') $('clock').textContent = fmtTime(now());
}

$('btnReplay').onclick = () => enterReplay(0, true);
$('btnExitReplay').onclick = () => {
  if (mode === 'archive') return newRoom();
  exitReplay();
};
$('btnPlay').onclick = () => {
  if (!replay) return;
  if (!replay.playing && replay.T >= endT() - 50) replay.T = 0;
  replay.playing = !replay.playing;
  updatePlayBtn();
};
$('speed').addEventListener('click', (e) => {
  const s = +e.target.dataset?.s;
  if (!s) return;
  replaySpeed = s;
  if (replay) replay.speed = s;
  [...$('speed').children].forEach((b) => b.classList.toggle('on', +b.dataset.s === s));
});

// timeline scrubbing
let scrubbing = false;
function scrubTo(e) {
  const r = tl.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  enterReplay(f * endT(), false);
}
tl.addEventListener('pointerdown', (e) => {
  scrubbing = true;
  tl.setPointerCapture(e.pointerId);
  scrubTo(e);
});
tl.addEventListener('pointermove', (e) => scrubbing && scrubTo(e));
tl.addEventListener('pointerup', () => (scrubbing = false));
tl.addEventListener('pointercancel', () => (scrubbing = false));

/* =========================================================================
   Clicking a dot
   ========================================================================= */

let popIdx = -1;
floor.addEventListener('click', (e) => {
  const r = floor.getBoundingClientRect();
  const mx = (e.clientX - r.left) / r.width, my = (e.clientY - r.top) / r.height;
  let best = null, bd = Infinity;
  for (const it of lastItems) {
    const dx = (it.rx - mx) * r.width, dy = (it.ry - my) * r.height;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  if (best && bd < 24 * 24) openDotPop(best, e.clientX - r.left, e.clientY - r.top);
  else {
    closeDotPop();
    focusIdx = -1;
  }
});

function openDotPop(it, x, y) {
  popIdx = it.idx;
  const st = computeStats(S, mode === 'live' ? now() : replay.T).per[it.idx];
  $('popName').textContent = it.name;
  const side = it.rz < 0 ? S.cfg.a : it.rz > 0 ? S.cfg.b : 'Undecided';
  const bits = [side, `${st.switches} switch${st.switches === 1 ? '' : 'es'}`];
  if (mode === 'live') bits.push(it.away ? 'phone offline' : byIdx[it.idx]?.bot ? 'test person' : 'connected');
  $('popMeta').textContent = bits.join(' · ');
  $('popPath').textContent = focusIdx === it.idx ? 'Hide path' : 'Show path';
  $('popKick').hidden = mode !== 'live';
  const pop = $('dotPop');
  pop.hidden = false;
  const wrap = $('floorWrap').getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.min(wrap.width - pw - 8, Math.max(8, x + 14)) + 'px';
  pop.style.top = Math.min(wrap.height - ph - 8, Math.max(8, y + 14)) + 'px';
}
function closeDotPop() {
  $('dotPop').hidden = true;
  popIdx = -1;
}
$('popPath').onclick = () => {
  focusIdx = focusIdx === popIdx ? -1 : popIdx;
  closeDotPop();
};
$('popKick').onclick = () => {
  const p = byIdx[popIdx];
  if (p && confirm(`Remove ${p.name} from the room? They can't rejoin from this phone.`)) removePlayer(p);
  closeDotPop();
};

/* =========================================================================
   Join screen / QR
   ========================================================================= */

function joinUrl() {
  return new URL(`join.html?room=${S.code}`, location.href).href;
}
function shortUrl() {
  const u = new URL('.', location.href);
  return (u.host + u.pathname).replace(/\/$/, '');
}

function drawQR(canvas, text) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  if (typeof qrcode === 'undefined') {
    ctx.fillStyle = '#000';
    ctx.font = `600 ${size / 14}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('QR unavailable', size / 2, size / 2);
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(Math.floor((c + quiet) * cell), Math.floor((r + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
}

function renderJoinInfo() {
  const url = joinUrl();
  drawQR($('qrSmall'), url);
  drawQR($('qrBig'), url);
  $('chipUrl').textContent = shortUrl();
  $('bigUrl').textContent = shortUrl();
  $('chipCode').textContent = S.code;
  $('bigCode').textContent = S.code;
  document.title = `Room ${S.code} · Debate Floor`;
}

function updateJoinOverlay() {
  if ($('joinOverlay').hidden) return;
  const list = activePlayers().filter((p) => !p.bot);
  $('joinedCount').textContent = list.length;
  const cloud = $('nameCloud');
  const shown = list.slice(-60).reverse();
  if (cloud.childElementCount === shown.length && cloud.firstChild?.textContent === shown[0]?.name) return;
  cloud.replaceChildren(...shown.map((p) => Object.assign(document.createElement('span'), { textContent: p.name })));
}

function toggleJoin(show = $('joinOverlay').hidden) {
  if (mode === 'archive') show = false;
  $('joinOverlay').hidden = !show;
  $('bigQuestion').textContent = S.cfg.q;
  updateJoinOverlay();
}
$('joinChip').onclick = () => toggleJoin(true);
$('btnStart').onclick = () => toggleJoin(false);
$('joinOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'joinOverlay') toggleJoin(false);
});

/* =========================================================================
   Marks
   ========================================================================= */

const PRESETS = ['Before the debate', 'Opening statements', 'Rebuttals', 'Closing statements', 'Final vote'];
function openMark() {
  if (mode === 'archive') return;
  const pop = $('markPop');
  pop.hidden = false;
  const b = $('btnMark').getBoundingClientRect();
  pop.style.left = Math.max(16, b.left) + 'px';
  pop.style.top = Math.max(16, b.top - pop.offsetHeight - 10) + 'px';
  const used = new Set(S.marks.map((m) => m.label));
  $('markChips').replaceChildren(
    ...PRESETS.filter((p) => !used.has(p)).map((p) => {
      const btn = document.createElement('button');
      btn.textContent = p;
      btn.onclick = () => addMark(p);
      return btn;
    })
  );
  $('markInput').value = '';
  $('markInput').focus();
}
function addMark(label) {
  label = cleanName(label).slice(0, 40) || `Moment ${S.marks.length + 1}`;
  S.marks.push({ t: now(), label });
  dirty = true;
  tlKey = '';
  $('markPop').hidden = true;
  toast(`Marked “${label}” at ${fmtTime(now())}`);
}
$('btnMark').onclick = (e) => {
  e.stopPropagation();
  $('markPop').hidden ? openMark() : ($('markPop').hidden = true);
};
$('markOk').onclick = () => addMark($('markInput').value);
$('markInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addMark($('markInput').value);
  if (e.key === 'Escape') $('markPop').hidden = true;
});
document.addEventListener('click', (e) => {
  if (!$('markPop').hidden && !$('markPop').contains(e.target) && e.target !== $('btnMark')) $('markPop').hidden = true;
});

/* =========================================================================
   Results
   ========================================================================= */

let resStats = null;
let sortKey = 'switches';
let sortDir = -1;
const sideTag = (z) => {
  const s = document.createElement('span');
  s.className = 'tag ' + (z < 0 ? 'a' : z > 0 ? 'b' : 'u');
  s.textContent = z < 0 ? S.cfg.a : z > 0 ? S.cfg.b : '—';
  return s;
};
const sideName = (z) => (z < 0 ? S.cfg.a : z > 0 ? S.cfg.b : 'undecided');

function openResults() {
  closeDotPop();
  if (replay?.playing) {
    replay.playing = false;
    updatePlayBtn();
  }
  const end = endT();
  resStats = computeStats(S, end);
  const st = resStats;
  $('resQuestion').textContent = S.cfg.q;
  $('resEyebrow').textContent = `Results · ${st.people.length} people · ${fmtTime(end)}`;

  // how the room moved
  const rows = [['First choice', st.opening, 'where each person first stood']];
  for (const m of S.marks) {
    const t = tallyAt(S, m.t);
    if (t) rows.push([m.label, t, fmtTime(m.t)]);
  }
  rows.push(['Final', st.final, mode === 'live' ? 'right now' : 'at the end']);
  $('shift').replaceChildren(
    ...rows.map(([label, t, sub]) => {
      const n = t.a + t.u + t.b || 1;
      const row = document.createElement('div');
      row.className = 'shift-row';
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = label;
      lbl.title = `${label} — ${sub}`;
      const stack = document.createElement('div');
      stack.className = 'stack';
      for (const [cls, v] of [['a', t.a], ['u', t.u], ['b', t.b]]) {
        if (!v) continue;
        const seg = document.createElement('div');
        seg.className = cls;
        seg.style.flex = `0 0 ${(v / n) * 100}%`;
        const pct = Math.round((v / n) * 100);
        seg.textContent = pct >= 7 ? `${pct}%` : '';
        seg.title = `${cls === 'a' ? S.cfg.a : cls === 'b' ? S.cfg.b : 'Undecided'}: ${v} (${pct}%)`;
        stack.append(seg);
      }
      row.append(lbl, stack);
      return row;
    })
  );

  const n0 = st.people.length || 1;
  const pct = (v) => Math.round((v / n0) * 100);
  const gains = [
    [S.cfg.a, pct(st.final.a) - pct(st.opening.a)],
    ['Undecided', pct(st.final.u) - pct(st.opening.u)],
    [S.cfg.b, pct(st.final.b) - pct(st.opening.b)],
  ].sort((x, y) => y[1] - x[1]);
  const conv = st.awards.convertsAB.length + st.awards.convertsBA.length;
  let shiftText = '';
  if (st.people.length) {
    const [winner, gain] = gains[0];
    shiftText = gain > 2 ? `${winner} gained ${gain} points since the first choice. ` : 'The room barely moved. ';
    shiftText += `${conv} ${conv === 1 ? 'person' : 'people'} ended on the other side from where they started.`;
  }
  $('netShift').textContent = shiftText;

  renderAwards(st);
  renderTable();
  $('resultsOverlay').hidden = false;
  $('resultsOverlay').scrollTop = 0;
}

function renderAwards(st) {
  const A = st.awards;
  const cards = [];
  const card = (title, r, why) => {
    const el = document.createElement('div');
    el.className = 'award';
    const t = Object.assign(document.createElement('div'), { className: 't', textContent: title });
    const who = Object.assign(document.createElement('div'), { className: 'who', textContent: r ? r.name : '—' });
    const w = Object.assign(document.createElement('div'), { className: 'why', textContent: r ? why : 'Nobody qualified (yet)' });
    if (r) el.dataset.idx = r.idx;
    el.append(t, who, w);
    cards.push(el);
  };
  card('Changed their mind most', A.flipper, A.flipper && `switched sides ${A.flipper.switches}×`);
  card('Biggest swing', A.swing, A.swing && `swung across ${Math.round(A.swing.swing * 100)}% of the room’s width`);
  card('Longest journey', A.journey, A.journey && `walked ${A.journey.travel.toFixed(1)}× across the room`);
  card('Rock solid', A.rock, A.rock && `never wavered — ${Math.round(A.rock.conviction * 100)}% conviction for ${sideName(A.rock.finalZone)}`);
  card('Fence sitter', A.fence, A.fence && `${fmtTime(A.fence.timeU)} in the undecided zone`);
  card('Last-minute switch', A.late?.r, A.late && `switched to ${sideName(A.late.to)} at ${fmtTime(A.late.t)}`);
  for (const [title, list] of [
    [`Converted: ${S.cfg.a} → ${S.cfg.b}`, A.convertsAB],
    [`Converted: ${S.cfg.b} → ${S.cfg.a}`, A.convertsBA],
  ]) {
    const el = document.createElement('div');
    el.className = 'award';
    const t = Object.assign(document.createElement('div'), { className: 't', textContent: title });
    const who = Object.assign(document.createElement('div'), { className: 'who', textContent: String(list.length) });
    const names = Object.assign(document.createElement('div'), { className: 'names' });
    names.textContent = list.length ? list.slice(0, 14).map((r) => r.name).join(', ') + (list.length > 14 ? ` and ${list.length - 14} more` : '') : 'Nobody';
    el.append(t, who, names);
    cards.push(el);
  }
  $('awards').replaceChildren(...cards);
}

const COLS = [
  ['name', 'Name'],
  ['firstSide', 'Started'],
  ['finalZone', 'Ended'],
  ['switches', 'Switches'],
  ['swing', 'Swing'],
  ['travel', 'Travel'],
  ['time', 'Time on each side'],
  ['path', 'Path'],
];

function renderTable() {
  const st = resStats;
  $('thead').replaceChildren(
    ...COLS.map(([k, label]) => {
      const th = document.createElement('th');
      th.textContent = label + (sortKey === k ? (sortDir < 0 ? ' ↓' : ' ↑') : '');
      if (sortKey === k) th.classList.add('sorted');
      if (k !== 'path' && k !== 'time') {
        th.onclick = () => {
          if (sortKey === k) sortDir = -sortDir;
          else {
            sortKey = k;
            sortDir = k === 'name' ? 1 : -1;
          }
          renderTable();
        };
      }
      return th;
    })
  );
  const q = $('search').value.trim().toLowerCase();
  const rows = st.people.filter((r) => !q || r.name.toLowerCase().includes(q));
  rows.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return ((va ?? 0) - (vb ?? 0)) * sortDir || a.name.localeCompare(b.name);
  });
  const end = st.endT;
  const trs = rows.map((r) => {
    const tr = document.createElement('tr');
    const td = (content, cls) => {
      const el = document.createElement('td');
      if (cls) el.className = cls;
      if (content instanceof Node) el.append(content);
      else el.textContent = content;
      tr.append(el);
      return el;
    };
    td(r.name + (r.bot ? ' (test)' : ''));
    td(sideTag(r.firstSide));
    td(sideTag(r.finalZone));
    td(String(r.switches), 'num');
    td(Math.round(r.swing * 100) + '%', 'num');
    td(r.travel.toFixed(1) + '×', 'num');
    const bar = document.createElement('div');
    bar.className = 'timebar';
    const tot = r.timeA + r.timeU + r.timeB || 1;
    for (const [cls, v] of [['a', r.timeA], ['u', r.timeU], ['b', r.timeB]]) {
      const s = document.createElement('div');
      s.className = cls;
      s.style.width = (v / tot) * 100 + '%';
      bar.append(s);
    }
    bar.title = `${S.cfg.a}: ${fmtTime(r.timeA)} · undecided: ${fmtTime(r.timeU)} · ${S.cfg.b}: ${fmtTime(r.timeB)}`;
    td(bar);
    const cv = document.createElement('canvas');
    td(cv);
    tr.onclick = () => showPath(r.idx);
    tr._draw = () => drawSpark(cv, r, end);
    return tr;
  });
  $('tbody').replaceChildren(...trs);
  requestAnimationFrame(() => trs.forEach((tr) => tr._draw()));
}

function drawSpark(cv, r, end) {
  fitCanvas(cv);
  const W = cv.width, H = cv.height, k = dpr();
  const c = cv.getContext('2d');
  c.fillStyle = hexA(C.a, 0.14);
  c.fillRect(0, 0, W, H / 2);
  c.fillStyle = hexA(C.b, 0.14);
  c.fillRect(0, H / 2, W, H / 2);
  if (!r.track.length) return;
  c.strokeStyle = C.text;
  c.lineWidth = 1.6 * k;
  c.lineJoin = 'round';
  c.beginPath();
  const pad = 2 * k;
  r.track.forEach(([t, x], i) => {
    const px = (t / end) * W, py = pad + x * (H - pad * 2);
    if (i) c.lineTo(px, py);
    else c.moveTo(px, py);
  });
  const last = r.track[r.track.length - 1];
  c.lineTo(W, pad + last[1] * (H - pad * 2));
  c.stroke();
}

function showPath(idx) {
  focusIdx = idx;
  $('resultsOverlay').hidden = true;
  toast(`Showing ${S.players[idx]?.name}’s path — click empty floor to clear`);
}

$('awards').addEventListener('click', (e) => {
  const el = e.target.closest('[data-idx]');
  if (el) showPath(+el.dataset.idx);
});
$('search').addEventListener('input', renderTable);
$('btnResults').onclick = openResults;
$('btnResults2').onclick = openResults;
$('btnCloseResults').onclick = () => ($('resultsOverlay').hidden = true);

/* =========================================================================
   Export / import
   ========================================================================= */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const stamp = () => new Date(S.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');

function exportJson() {
  const data = { ...S, endedAt: S.endedAt || (mode === 'archive' ? null : Date.now()) };
  download(`debate-${S.code}-${stamp()}.json`, JSON.stringify(data), 'application/json');
}

function exportCsv() {
  const st = computeStats(S, endT());
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['name', 'test_person', 'first_side', 'final_side', 'switches', 'converted', 'swing_pct', 'travel_room_widths', 'conviction_pct', `seconds_${S.cfg.a}`, 'seconds_undecided', `seconds_${S.cfg.b}`, 'joined_at'];
  const lines = [head.map(esc).join(',')];
  for (const r of st.people) {
    lines.push(
      [r.name, r.bot ? 'yes' : '', sideName(r.firstSide), sideName(r.finalZone), r.switches, r.converted ? 'yes' : '', Math.round(r.swing * 100), r.travel.toFixed(2), Math.round(r.conviction * 100), Math.round(r.timeA / 1000), Math.round(r.timeU / 1000), Math.round(r.timeB / 1000), fmtTime(r.joinT)]
        .map(esc)
        .join(',')
    );
  }
  download(`debate-${S.code}-${stamp()}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}

$('btnJson').onclick = exportJson;
$('btnSave').onclick = exportJson;
$('btnCsv').onclick = exportCsv;
$('btnCsv2').onclick = exportCsv;
$('btnLoad').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  let data;
  try {
    data = JSON.parse(await f.text());
  } catch {
    return toast('That file is not a saved session');
  }
  if (!validSession(data)) return toast('That file is not a saved session');
  if (mode !== 'archive' && !confirm('Open this saved session? The live room closes (it stays autosaved — reload this page to resume it).')) return;
  save();
  net?.destroy();
  net = null;
  mode = 'archive';
  S = data;
  hydrate();
  focusIdx = -1;
  replay = { rep: new Replayer(S), T: endT(), playing: false, speed: replaySpeed };
  toggleJoin(false);
  closeSettings();
  applyCfgUI();
  renderJoinInfo();
  syncModeUI();
  toast('Saved session loaded — press Play to replay it');
};

function newRoom() {
  if (!confirm('Start a new room? The current session is removed from autosave — use “Save session file” first if you want to keep it.')) return;
  store.del(SAVE_KEY);
  location.reload();
}
$('btnReset').onclick = newRoom;

/* =========================================================================
   Settings
   ========================================================================= */

function applyTheme() {
  document.documentElement.dataset.theme = S.cfg.theme === 'light' ? 'light' : 'dark';
  readColors();
}

function applyCfgUI() {
  const c = S.cfg;
  $('question').textContent = c.q;
  $('bigQuestion').textContent = c.q;
  $('nameA').textContent = c.a;
  $('nameB').textContent = c.b;
  $('btnNames').classList.toggle('on', c.names);
  $('btnHeat').classList.toggle('on', c.heat);
  $('joinChip').hidden = !c.chip || mode === 'archive';
  applyTheme();
  syncModeUI();
}

function cfgChanged() {
  applyCfgUI();
  dirty = true;
  tlKey = '';
  const { q, a, b, neutral, names, heat, crowd, chip, theme } = S.cfg;
  store.set('df:cfg', { q, a, b, neutral, names, heat, crowd, chip, theme });
  if (mode !== 'archive') broadcastCfg();
}

function openSettings() {
  const c = S.cfg;
  $('setQ').value = c.q;
  $('setA').value = c.a;
  $('setB').value = c.b;
  $('setNeutral').checked = c.neutral;
  $('setNames').checked = c.names;
  $('setHeat').checked = c.heat;
  $('setCrowd').checked = c.crowd;
  $('setChip').checked = c.chip;
  $('setLight').checked = c.theme === 'light';
  $('settings').classList.add('open');
}
function closeSettings() {
  $('settings').classList.remove('open');
}

$('setQ').oninput = (e) => {
  S.cfg.q = e.target.value.slice(0, 140) || 'Which side are you on?';
  cfgChanged();
};
$('setA').oninput = (e) => {
  S.cfg.a = cleanName(e.target.value).slice(0, 28) || 'Side A';
  cfgChanged();
};
$('setB').oninput = (e) => {
  S.cfg.b = cleanName(e.target.value).slice(0, 28) || 'Side B';
  cfgChanged();
};
const bindToggle = (id, key, map = (v) => v) =>
  ($(id).onchange = (e) => {
    S.cfg[key] = map(e.target.checked);
    cfgChanged();
  });
bindToggle('setNeutral', 'neutral');
bindToggle('setNames', 'names');
bindToggle('setHeat', 'heat');
bindToggle('setCrowd', 'crowd');
bindToggle('setChip', 'chip');
bindToggle('setLight', 'theme', (v) => (v ? 'light' : 'dark'));

$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = closeSettings;
$('btnBots').onclick = () => addBots(12);
$('btnNoBots').onclick = () => {
  const list = activePlayers().filter((p) => p.bot);
  list.forEach(removePlayer);
  toast(list.length ? `Removed ${list.length} test people` : 'No test people in the room');
};
$('btnNames').onclick = () => {
  S.cfg.names = !S.cfg.names;
  cfgChanged();
};
$('btnHeat').onclick = () => {
  S.cfg.heat = !S.cfg.heat;
  cfgChanged();
};
$('btnLock').onclick = toggleLock;
function toggleLock() {
  if (mode === 'archive') return;
  S.cfg.locked = !S.cfg.locked;
  cfgChanged();
  toast(S.cfg.locked ? 'Voting locked — phones can’t move' : 'Voting open again');
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$('btnFull').onclick = toggleFull;

// fade the control bar while presenting
let idleTimer;
function wake() {
  $('app').classList.remove('quiet');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.fullscreenElement) $('app').classList.add('quiet');
  }, 3500);
}
document.addEventListener('mousemove', wake);
document.addEventListener('fullscreenchange', wake);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') {
    $('joinOverlay').hidden = true;
    $('resultsOverlay').hidden = true;
    $('markPop').hidden = true;
    closeSettings();
    closeDotPop();
    focusIdx = -1;
  } else if (k === 'q') toggleJoin();
  else if (k === 'm') openMark();
  else if (k === 'l') toggleLock();
  else if (k === 'r') mode === 'live' ? enterReplay(0, true) : mode === 'replay' && exitReplay();
  else if (k === 's') $('resultsOverlay').hidden ? openResults() : ($('resultsOverlay').hidden = true);
  else if (k === 'n') $('btnNames').click();
  else if (k === 'h') $('btnHeat').click();
  else if (k === 'f') toggleFull();
  else if (k === ' ' && replay) {
    e.preventDefault();
    $('btnPlay').click();
  } else return;
  e.preventDefault();
});

/* =========================================================================
   Toast
   ========================================================================= */

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* =========================================================================
   Boot
   ========================================================================= */

function begin(isResume) {
  mode = 'live';
  hydrate();
  applyCfgUI();
  renderJoinInfo();
  startNet(isResume);
  syncModeUI();
  if (!isResume || !activePlayers().length) toggleJoin(true);
  else toast(`Resumed room ${S.code} — phones reconnect by themselves`);
  save();
}

function boot() {
  keepAwake();
  setInterval(flushTick, REC_MIN);
  setInterval(secondTick, 1000);
  let lastBot = performance.now();
  setInterval(() => {
    const t = performance.now();
    botTick(t - lastBot);
    lastBot = t;
  }, 200);
  setInterval(() => dirty && save(), 4000);
  window.addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save());

  const saved = store.get(SAVE_KEY);
  const fresh = validSession(saved) && Date.now() - (saved.savedAt || 0) < 48 * 3600e3;
  if (fresh && saved.players.length) {
    $('resumeText').textContent = `Room ${saved.code} · “${saved.cfg.q}” · ${saved.players.filter((p) => !p.bot).length} people · started ${new Date(saved.startedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    $('startOverlay').hidden = false;
    S = saved; // so the frame loop has something to draw behind the dialog
    readColors();
    $('btnResume').onclick = () => {
      $('startOverlay').hidden = true;
      begin(true);
    };
    $('btnNewRoom').onclick = () => {
      $('startOverlay').hidden = true;
      S = newSession(makeCode());
      begin(false);
    };
  } else {
    S = fresh ? saved : newSession(makeCode());
    readColors();
    begin(!!fresh);
  }
  requestAnimationFrame(frame);
}

boot();
