// Phone view: pick a name, then drag your dot left/right to take a side.

import { normCode, makeId, zoneOf, cleanName, store, cssVar, hexA, keepAwake, fitCanvas, dpr, NEUTRAL_HALF } from './shared.js';
import { ClientNet } from './net.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fresh = params.has('fresh'); // testing: a new participant per tab
let code = normCode(params.get('room') || params.get('code'));

// Per-tab storage when testing with ?fresh, so several tabs = several people.
const idStore = fresh
  ? {
      get: (k, d = null) => {
        try {
          const v = sessionStorage.getItem(k);
          return v == null ? d : JSON.parse(v);
        } catch {
          return d;
        }
      },
      set: (k, v) => {
        try {
          sessionStorage.setItem(k, JSON.stringify(v));
        } catch {}
      },
      del: (k) => {
        try {
          sessionStorage.removeItem(k);
        } catch {}
      },
    }
  : store;

let name = cleanName(params.get('name') || idStore.get('df:name', ''));
let me = { pid: null, x: 0.5, y: 0.5, placed: false };
const disp = { x: 0.5, y: 0.5 };
let cfg = { q: '', a: 'Side A', b: 'Side B', neutral: true, locked: false, crowd: true };
let crowd = null;
let net = null;
let welcomed = false;
let dragging = false;
let lastZone = null;
let lastSent = 0;
let sendTimer = null;
let C = {};

/* ---------------- views ---------------- */

function show(view) {
  for (const id of ['joinView', 'mainView', 'msgView']) $(id).hidden = id !== view;
}

function showJoin(rename = false) {
  show('joinView');
  if (code) {
    $('roomLine').hidden = false;
    $('roomCode').textContent = code;
    $('codeField').hidden = true;
  } else {
    $('codeField').hidden = false;
    $('roomLine').hidden = true;
  }
  $('nameInput').value = name;
  $('joinBtn').textContent = rename ? 'Save' : 'Join';
  setTimeout(() => (code ? $('nameInput') : $('codeInput')).focus(), 50);
}

function showMsg(title, text, retry = false) {
  show('msgView');
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  $('msgBtn').hidden = !retry;
}

$('msgBtn').onclick = () => location.reload();

$('joinBtn').onclick = submitJoin;
for (const id of ['nameInput', 'codeInput']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });
}
$('codeInput').addEventListener('input', (e) => (e.target.value = normCode(e.target.value)));
$('renameBtn').onclick = () => showJoin(true);

function submitJoin() {
  if (!code) {
    const c = normCode($('codeInput').value);
    if (c.length < 4) return toast('Enter the 4-letter room code');
    code = c;
  }
  const n = cleanName($('nameInput').value);
  if (!n) return toast('Please enter your name');
  name = n;
  store.set('df:name', name);
  idStore.set('df:name', name);
  if (net) {
    // rename while connected
    show('mainView');
    $('pName').textContent = name;
    sendHello();
    return;
  }
  start();
}

/* ---------------- connection ---------------- */

function start() {
  const key = 'df:p:' + code;
  const saved = idStore.get(key);
  me = saved && saved.pid ? saved : { pid: makeId(), x: 0.5, y: 0.5, placed: false };
  disp.x = me.x;
  disp.y = me.y;
  idStore.set(key, me);
  idStore.set('df:name', name);
  history.replaceState(null, '', `?room=${code}${fresh ? '&fresh' : ''}${params.has('relayonly') ? '&relayonly' : ''}`);

  show('mainView');
  $('pName').textContent = name;
  $('pQ').textContent = `Connecting to room ${code}…`;
  keepAwake();
  readColors();
  requestAnimationFrame(frame);

  net = new ClientNet(code, {
    onOpen: sendHello,
    onMessage: handle,
    onStatus: setConn,
  });
  net.start();

  setInterval(() => {
    if (Date.now() - lastSent > 3500 && net.send({ t: 'ping' })) lastSent = Date.now();
    // Stuck for a while? Tell people what usually helps.
    const stuck = net.status !== 'connected' && net.status !== 'unsupported' && net.downFor > 15000;
    const hint = $('pHint');
    if (stuck && hint.hidden) {
      hint.textContent =
        net.status === 'notfound'
          ? `Room ${code} isn't open right now. Check the code on the big screen.`
          : "Can't reach the big screen. Try switching between Wi-Fi and mobile data. Your choice is kept and sent as soon as you're connected.";
    }
    hint.hidden = !stuck;
  }, 1000);
}

function sendHello() {
  net?.send({ t: 'hello', pid: me.pid, name, x: me.x, y: me.y, placed: me.placed });
  lastSent = Date.now();
}

function handle(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'welcome':
      welcomed = true;
      applyCfg(m.cfg);
      if (!me.placed && m.you) {
        me.x = m.you.x;
        me.y = m.you.y;
        disp.x = me.x;
        disp.y = me.y;
      }
      save();
      updateStance();
      break;
    case 'cfg':
      applyCfg(m.cfg);
      break;
    case 'crowd':
      crowd = m;
      updateStance();
      break;
    case 'kicked':
      net.stop();
      idStore.del('df:p:' + code);
      showMsg('You were removed', 'The host removed you from this room.');
      break;
    case 'replaced':
      net.stop();
      showMsg('Open somewhere else', 'You joined this room from another tab or device.', true);
      break;
  }
}

function setConn(s) {
  const map = {
    connecting: ['warn', 'connecting'],
    connected: ['ok', 'live'],
    reconnecting: ['warn', 'reconnecting'],
    notfound: ['bad', 'room not found'],
    offline: ['bad', 'offline'],
    unsupported: ['bad', 'not supported'],
    denied: ['bad', 'no access'],
  };
  const [cls, txt] = map[s] || ['warn', s];
  $('connDot').className = 'dot-status ' + cls;
  $('connText').textContent = txt;
  if (s === 'notfound' && !welcomed) {
    $('pQ').textContent = `Looking for room ${code}…`;
    $('pStance').innerHTML = '';
    $('pStance').append(
      'Room not found yet',
      Object.assign(document.createElement('small'), {
        textContent: 'Is the big screen open? Check the code — retrying automatically.',
      })
    );
  }
  if (s === 'unsupported') {
    showMsg("Can't connect", 'This browser does not support live connections (WebRTC). Try Safari or Chrome.', true);
  }
  if (s === 'connected' && welcomed) updateStance();
}

function applyCfg(c) {
  if (!c) return;
  cfg = { ...cfg, ...c };
  $('pQ').textContent = cfg.q || 'Which side are you on?';
  $('pA').textContent = cfg.a;
  $('pB').textContent = cfg.b;
  $('btnA').textContent = cfg.a;
  $('btnB').textContent = cfg.b;
  $('btnU').hidden = !cfg.neutral;
  document.querySelector('.p-btns').style.gridTemplateColumns = cfg.neutral ? '1fr auto 1fr' : '1fr 1fr';
  $('pLocked').hidden = !cfg.locked;
  updateStance();
}

/* ---------------- moving ---------------- */

function save() {
  if (me.pid) idStore.set('df:p:' + code, me);
}

function sendPos() {
  clearTimeout(sendTimer);
  sendTimer = null;
  lastSent = Date.now();
  net?.send({ t: 'pos', x: +me.x.toFixed(4), y: +me.y.toFixed(4) });
  save();
}

function queueSend() {
  const dt = Date.now() - lastSent;
  if (dt >= 70) sendPos();
  else if (!sendTimer) sendTimer = setTimeout(sendPos, 70 - dt);
}

function setMe(x, y, animate) {
  me.x = Math.min(0.97, Math.max(0.03, x));
  me.y = Math.min(0.95, Math.max(0.05, y));
  me.placed = true;
  if (!animate) {
    disp.x = me.x;
    disp.y = me.y;
  }
  const z = zoneOf(me.x, cfg.neutral, true);
  if (lastZone !== null && z !== lastZone) navigator.vibrate?.(14);
  lastZone = z;
  updateStance();
}

const cv = $('pFloor');
const ctx = cv.getContext('2d');

function pointerTo(e) {
  const r = cv.getBoundingClientRect();
  setMe((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, false);
  queueSend();
}
cv.addEventListener('pointerdown', (e) => {
  if (cfg.locked) return toast('Voting is paused');
  dragging = true;
  cv.setPointerCapture(e.pointerId);
  pointerTo(e);
});
cv.addEventListener('pointermove', (e) => {
  if (dragging) pointerTo(e);
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  sendPos();
};
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);

document.querySelectorAll('[data-go]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (cfg.locked) return toast('Voting is paused');
    const go = btn.dataset.go;
    const x = go === 'a' ? 0.1 + Math.random() * 0.2 : go === 'b' ? 0.7 + Math.random() * 0.2 : 0.5 + (Math.random() - 0.5) * 0.06;
    const y = me.placed ? me.y : 0.15 + Math.random() * 0.7;
    setMe(x, y, true);
    sendPos();
  });
});

/* ---------------- stance text ---------------- */

function updateStance() {
  const el = $('pStance');
  if (!welcomed && net?.status !== 'connected') return;
  el.innerHTML = '';
  if (!me.placed) {
    el.textContent = 'Drag your dot to take a side';
    return;
  }
  const z = zoneOf(me.x, cfg.neutral, true);
  const strength = Math.abs(me.x - 0.5) * 2;
  const main = document.createElement('span');
  const sub = document.createElement('small');
  if (z === 0) {
    main.textContent = 'Undecided';
  } else {
    main.textContent = z < 0 ? cfg.a : cfg.b;
    main.style.color = z < 0 ? 'var(--a)' : 'var(--b)';
  }
  const parts = [];
  if (z !== 0) parts.push(strength > 0.7 ? 'strongly' : strength < 0.35 ? 'leaning' : 'convinced');
  const t = crowd?.tally;
  if (cfg.crowd && t && t.n > 1) {
    const same = z < 0 ? t.a : z > 0 ? t.b : t.u;
    const pct = Math.round((same / t.n) * 100);
    parts.push(z === 0 ? `${pct}% of the room is undecided` : `${pct}% of the room is with you`);
  }
  sub.textContent = parts.join(' · ');
  el.append(main, sub);
}

/* ---------------- drawing ---------------- */

function readColors() {
  C = { a: cssVar('--a'), b: cssVar('--b'), u: cssVar('--u'), text: cssVar('--text'), bg: cssVar('--panel'), line: cssVar('--line') };
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', readColors);

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (!dragging) {
    const k = 1 - Math.exp(-dt * 10);
    disp.x += (me.x - disp.x) * k;
    disp.y += (me.y - disp.y) * k;
  }
  draw(now);
  requestAnimationFrame(frame);
}

function draw(now) {
  fitCanvas(cv);
  const W = cv.width, H = cv.height, k = dpr();
  ctx.clearRect(0, 0, W, H);
  const nx = cfg.neutral ? NEUTRAL_HALF : 0;
  ctx.fillStyle = hexA(C.a, 0.14);
  ctx.fillRect(0, 0, W * (0.5 - nx), H);
  ctx.fillStyle = hexA(C.b, 0.14);
  ctx.fillRect(W * (0.5 + nx), 0, W * (0.5 - nx) + 1, H);
  if (nx) {
    ctx.fillStyle = hexA(C.u, 0.07);
    ctx.fillRect(W * (0.5 - nx), 0, W * nx * 2, H);
  }
  ctx.save();
  ctx.strokeStyle = hexA(C.u, 0.45);
  ctx.setLineDash([6 * k, 6 * k]);
  ctx.lineWidth = 1.5 * k;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.restore();

  // everyone else, faintly
  if (cfg.crowd && crowd?.d) {
    const d = crowd.d;
    const r = 4.5 * k;
    for (let i = 0, j = 0; i < d.length; i += 3, j++) {
      if (j === crowd.me) continue;
      const z = d[i + 2];
      ctx.fillStyle = hexA(z === 0 ? C.a : z === 2 ? C.b : C.u, 0.5);
      ctx.beginPath();
      ctx.arc((d[i] / 255) * W, (d[i + 1] / 255) * H, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // me
  const x = disp.x * W, y = disp.y * H;
  const z = zoneOf(disp.x, cfg.neutral, me.placed);
  const col = z < 0 ? C.a : z > 0 ? C.b : C.u;
  const R = 16 * k;
  if (!me.placed) {
    const p = (now % 1600) / 1600;
    ctx.strokeStyle = hexA(C.text, 0.5 * (1 - p));
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.arc(x, y, R + p * 26 * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = hexA(col, dragging ? 0.28 : 0.18);
  ctx.beginPath();
  ctx.arc(x, y, R * (dragging ? 2.2 : 1.7), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = col;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3 * k;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.font = `700 ${13 * k}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const label = me.placed ? 'You' : 'Drag me';
  const ly = y - R - 8 * k < 14 * k ? y + R + 22 * k : y - R - 8 * k;
  ctx.lineWidth = 4 * k;
  ctx.strokeStyle = C.bg;
  ctx.strokeText(label, x, ly);
  ctx.fillStyle = C.text;
  ctx.fillText(label, x, ly);
}

/* ---------------- toast ---------------- */

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- boot ---------------- */

if (code && name) start();
else showJoin();
