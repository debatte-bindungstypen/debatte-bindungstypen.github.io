// Fallback transport (used only when no Firebase database is set in config.js).
// GitHub Pages only serves static files, so in this mode the presenter's
// browser acts as the "server": phones open a WebRTC data channel straight to it.
// PeerJS's free cloud broker only introduces the two sides. When a direct
// connection is impossible (mobile data, university Wi-Fi), the data goes through
// the relay ("TURN") server configured in config.js.
//
// net.js picks this file or net-firebase.js; both expose the same interface.

/* global Peer */
import { hostPeerId } from './shared.js';
import { RELAY } from './config.js';

const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const params = new URLSearchParams(location.search);
// ?relayonly — testing: force every connection through the relay, as on mobile data.
const RELAY_ONLY = params.has('relayonly');

export function relayConfigured() {
  return !!((RELAY.meteredApp && RELAY.meteredApiKey) || (RELAY.iceServers || []).some((s) => /turns?:/.test(String(s.urls))));
}

let icePromise = null;
/** STUN + relay servers. Metered credentials are fetched once per page load. */
export function loadIceServers() {
  if (icePromise) return icePromise;
  icePromise = (async () => {
    const list = [...STUN, ...(RELAY.iceServers || [])];
    let ok = true;
    if (RELAY.meteredApp && RELAY.meteredApiKey) {
      ok = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const url = `https://${encodeURIComponent(RELAY.meteredApp)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(RELAY.meteredApiKey)}`;
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const servers = res.ok ? await res.json() : null;
        if (Array.isArray(servers) && servers.length) {
          list.push(...servers);
          ok = true;
        }
      } catch {}
    }
    if (!ok) icePromise = null; // try again on the next (re)connect
    return list;
  })();
  return icePromise;
}

async function peerOptions() {
  const iceServers = await loadIceServers();
  return { debug: 0, config: { iceServers, ...(RELAY_ONLY ? { iceTransportPolicy: 'relay' } : {}) } };
}

/** 'direct' | 'relay' | null — how an open connection actually travels. */
async function pathOf(pc) {
  if (!pc?.getStats) return null;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
  });
  if (!pair)
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
  if (!pair) return null;
  const l = stats.get(pair.localCandidateId);
  const r = stats.get(pair.remoteCandidateId);
  return l?.candidateType === 'relay' || r?.candidateType === 'relay' ? 'relay' : 'direct';
}

export class HostNet {
  /**
   * @param {string} code room code
   * @param {{onReady?:Function,onError?:Function,onStatus?:Function,onConnect?:Function,onMessage?:Function,onDisconnect?:Function}} h
   */
  constructor(code, h) {
    this.code = code;
    this.h = h;
    this.conns = new Map(); // connectionId -> DataConnection
    this.via = new Map(); // connectionId -> 'direct' | 'relay'
    this.peer = null;
    this.dead = false;
    this.health = null;
  }

  async start() {
    this.dead = false;
    this.opts = await peerOptions();
    if (this.dead) return;
    this._spawn();
    // Health check: if we lost the broker, reconnect; if the peer died before it
    // ever registered (e.g. room code still held by a closing tab), start over.
    // Already-connected phones talk to us directly and keep working meanwhile.
    this.health = setInterval(async () => {
      if (this.dead) return;
      const p = this.peer;
      if (!p || p.destroyed) {
        this.opts = await peerOptions(); // retries the relay lookup if it failed
        if (!this.dead) this._spawn();
      } else if (p.disconnected) {
        try {
          p.reconnect();
        } catch {
          this._spawn();
        }
      }
    }, 3000);
  }

  _spawn() {
    if (typeof Peer === 'undefined') {
      this.h.onError?.('browser');
      return;
    }
    const peer = new Peer(hostPeerId(this.code), this.opts);
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.h.onStatus?.('online');
      this.h.onReady?.();
    });
    peer.on('connection', (conn) => this._accept(conn));
    peer.on('disconnected', () => {
      if (this.dead || peer.destroyed || this.peer !== peer) return;
      this.h.onStatus?.('reconnecting');
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      const type = err?.type || 'unknown';
      if (type === 'unavailable-id') this.h.onError?.('taken');
      else if (type === 'browser-incompatible') this.h.onError?.('browser');
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) this.h.onStatus?.('reconnecting');
      // 'peer-unavailable' / 'webrtc' concern single connections: ignore
    });
  }

  _accept(conn) {
    const cid = conn.connectionId;
    let opened = false;
    const gone = () => {
      this.via.delete(cid);
      if (!this.conns.has(cid)) return;
      this.conns.delete(cid);
      this.h.onDisconnect?.(cid);
    };
    conn.on('open', () => {
      opened = true;
      this.conns.set(cid, conn);
      this.h.onConnect?.(cid);
      // Find out whether this phone came in directly or through the relay.
      for (const ms of [2500, 12000]) {
        setTimeout(() => {
          if (!this.conns.has(cid)) return;
          pathOf(conn.peerConnection)
            .then((p) => p && this.conns.has(cid) && this.via.set(cid, p))
            .catch(() => {});
        }, ms);
      }
    });
    conn.on('data', (d) => {
      if (!opened) return;
      this.h.onMessage?.(cid, d);
    });
    conn.on('close', gone);
    conn.on('error', gone);
  }

  send(cid, msg) {
    const c = this.conns.get(cid);
    if (!c || !c.open) return false;
    try {
      c.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  close(cid) {
    const c = this.conns.get(cid);
    this.conns.delete(cid);
    this.via.delete(cid);
    try {
      c?.close();
    } catch {}
  }

  get size() {
    return this.conns.size;
  }

  get relayed() {
    let n = 0;
    for (const v of this.via.values()) if (v === 'relay') n++;
    return n;
  }

  /** Extra text for the big screen's status line, and whether it's a warning. */
  get note() {
    if (!relayConfigured()) return ' · no server set up (only phones on the same Wi-Fi can join)';
    return this.relayed ? ` (${this.relayed} via relay)` : '';
  }
  get degraded() {
    return !relayConfigured();
  }

  destroy() {
    this.dead = true;
    clearInterval(this.health);
    try {
      this.peer?.destroy();
    } catch {}
    this.conns.clear();
    this.via.clear();
  }
}

export class ClientNet {
  /**
   * @param {string} code room code
   * @param {{onOpen?:Function,onMessage?:Function,onStatus?:Function}} h
   * status: 'connecting' | 'connected' | 'reconnecting' | 'notfound' | 'offline' | 'unsupported'
   */
  constructor(code, h) {
    this.code = code;
    this.h = h;
    this.peer = null;
    this.conn = null;
    this.attempt = 0;
    this.lastRx = 0;
    this.lastOk = Date.now(); // last time we were connected (or started trying)
    this.retryTimer = null;
    this.status = 'idle';
    this.stopped = false;
    this.via = null;
  }

  async start() {
    if (typeof Peer === 'undefined') {
      this._set('unsupported');
      return;
    }
    this._set('connecting');
    this.opts = await peerOptions();
    this._ensure();
    // Watchdog: the host talks at least once a second. Silence means the link is dead.
    this.watch = setInterval(() => {
      if (this.status === 'connected') this.lastOk = Date.now();
      if (this.status === 'connected' && Date.now() - this.lastRx > 9000) this._drop();
    }, 1500);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || this.stopped) return;
      if (this.status !== 'connected' || Date.now() - this.lastRx > 4000) {
        this.attempt = 0;
        this._drop();
      }
    });
    window.addEventListener('online', () => {
      this.attempt = 0;
      if (this.status !== 'connected') this._ensure();
    });
  }

  /** Milliseconds since we last had a working connection. */
  get downFor() {
    return this.status === 'connected' ? 0 : Date.now() - this.lastOk;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watch);
    clearTimeout(this.retryTimer);
    try {
      this.conn?.close();
    } catch {}
    try {
      this.peer?.destroy();
    } catch {}
  }

  _set(s) {
    if (this.status === s) return;
    if (this.status === 'connected') this.lastOk = Date.now();
    this.status = s;
    this.h.onStatus?.(s);
  }

  async _ensure() {
    if (this.stopped) return;
    const p = this.peer;
    if (p && !p.destroyed) {
      if (p.disconnected) {
        try {
          p.reconnect();
          return;
        } catch {
          this.peer = null;
        }
      } else if (p.open) {
        this._connect();
        return;
      } else {
        return; // still opening; 'open' will call _connect
      }
    }
    if (this.status !== 'reconnecting' && this.status !== 'notfound') this._set('connecting');
    this.opts = await peerOptions(); // cached; re-fetches only if the relay lookup failed
    if (this.stopped) return;
    const peer = new Peer(this.opts);
    this.peer = peer;
    peer.on('open', () => this._connect());
    peer.on('disconnected', () => {
      if (!this.stopped && this.status !== 'connected') this._retry();
    });
    peer.on('error', (err) => {
      const type = err?.type || 'unknown';
      if (type === 'peer-unavailable') this._set('notfound');
      else if (type === 'browser-incompatible') return this._set('unsupported');
      else if (this.status !== 'connected') this._set(navigator.onLine === false ? 'offline' : 'reconnecting');
      if (this.status !== 'connected') this._retry();
    });
  }

  _connect() {
    if (this.stopped) return;
    try {
      this.conn?.close();
    } catch {}
    const c = this.peer.connect(hostPeerId(this.code), { reliable: true, serialization: 'json' });
    this.conn = c;
    const openTimer = setTimeout(() => {
      if (this.conn === c && !c.open) this._drop();
    }, 15000);
    c.on('open', () => {
      clearTimeout(openTimer);
      if (this.conn !== c) return;
      this.attempt = 0;
      this.lastRx = Date.now();
      this._set('connected');
      this.h.onOpen?.();
      setTimeout(() => {
        if (this.conn === c) pathOf(c.peerConnection).then((p) => (this.via = p)).catch(() => {});
      }, 2500);
    });
    c.on('data', (d) => {
      if (this.conn !== c) return;
      this.lastRx = Date.now();
      this.h.onMessage?.(d);
    });
    const lost = () => {
      clearTimeout(openTimer);
      if (this.conn !== c) return;
      this.conn = null;
      if (this.status === 'connected') this._set('reconnecting');
      this._retry();
    };
    c.on('close', lost);
    c.on('error', lost);
  }

  _drop() {
    const c = this.conn;
    this.conn = null;
    try {
      c?.close();
    } catch {}
    if (this.status === 'connected') this._set('reconnecting');
    this._retry();
  }

  _retry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(800 * 2 ** this.attempt, 5000) + Math.random() * 400;
    this.attempt++;
    this.retryTimer = setTimeout(() => this._ensure(), delay);
  }

  send(msg) {
    const c = this.conn;
    if (!c || !c.open) return false;
    try {
      c.send(msg);
      return true;
    } catch {
      return false;
    }
  }
}
