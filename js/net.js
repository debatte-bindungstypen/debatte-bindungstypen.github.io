// Realtime layer. GitHub Pages only serves static files, so the presenter's
// browser acts as the "server": phones open a WebRTC data channel straight to it.
// PeerJS's free cloud broker is only used to introduce the two sides; it also
// ships public TURN relays for networks where a direct connection is blocked.
//
// Everything network-specific lives in this file, so the transport can be
// swapped (e.g. for Firebase) without touching the app code.

/* global Peer */
import { hostPeerId } from './shared.js';

const PEER_OPTS = { debug: 0 };

export class HostNet {
  /**
   * @param {string} code room code
   * @param {{onReady?:Function,onError?:Function,onStatus?:Function,onConnect?:Function,onMessage?:Function,onDisconnect?:Function}} h
   */
  constructor(code, h) {
    this.code = code;
    this.h = h;
    this.conns = new Map(); // connectionId -> DataConnection
    this.peer = null;
    this.dead = false;
    this.health = null;
  }

  start() {
    this.dead = false;
    this._spawn();
    // Health check: if we lost the broker, reconnect; if the peer died before it
    // ever registered (e.g. room code still held by a closing tab), start over.
    // Already-connected phones talk to us directly and keep working meanwhile.
    this.health = setInterval(() => {
      if (this.dead) return;
      const p = this.peer;
      if (!p || p.destroyed) this._spawn();
      else if (p.disconnected) {
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
    const peer = new Peer(hostPeerId(this.code), PEER_OPTS);
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
      if (!this.conns.has(cid)) return;
      this.conns.delete(cid);
      this.h.onDisconnect?.(cid);
    };
    conn.on('open', () => {
      opened = true;
      this.conns.set(cid, conn);
      this.h.onConnect?.(cid);
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
    try {
      c?.close();
    } catch {}
  }

  get size() {
    return this.conns.size;
  }

  destroy() {
    this.dead = true;
    clearInterval(this.health);
    try {
      this.peer?.destroy();
    } catch {}
    this.conns.clear();
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
    this.retryTimer = null;
    this.status = 'idle';
    this.stopped = false;
  }

  start() {
    if (typeof Peer === 'undefined') {
      this._set('unsupported');
      return;
    }
    this._ensure();
    // Watchdog: the host talks at least once a second. Silence means the link is dead.
    this.watch = setInterval(() => {
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
    this.status = s;
    this.h.onStatus?.(s);
  }

  _ensure() {
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
    const peer = new Peer(PEER_OPTS);
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
