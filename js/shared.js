// Shared helpers for the big screen (host) and the phones.

export const PEER_PREFIX = 'debatefloor-v1-';
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O, easy to read aloud
export const NEUTRAL_HALF = 0.07; // half-width of the "undecided" strip in the middle

export function makeCode(len = 4) {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
}

export const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
export const hostPeerId = (code) => PEER_PREFIX + code;

export function makeId() {
  const a = new Uint32Array(3);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => n.toString(36)).join('').slice(0, 14);
}

/** -1 = side A (left), 0 = undecided / not placed yet, 1 = side B (right) */
export function zoneOf(x, neutral, placed = true) {
  if (!placed) return 0;
  if (neutral && Math.abs(x - 0.5) < NEUTRAL_HALF) return 0;
  return x < 0.5 ? -1 : 1;
}

export const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(+v) ? +v : 0.5));

export function cleanName(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Keep the screen on (phones would otherwise sleep and drop the connection). */
export function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  const req = () => navigator.wakeLock.request('screen').catch(() => {});
  req();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') req();
  });
}

/** Size a canvas to its CSS box at device pixel ratio. Returns true if it changed. */
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

export function dpr() {
  return Math.min(window.devicePixelRatio || 1, 2.5);
}
