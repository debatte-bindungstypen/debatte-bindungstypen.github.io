// Jackbox-style transport: the big screen and every phone talk to a Firebase
// Realtime Database over normal HTTPS/WebSocket traffic, so it works on any
// network where websites load (mobile data, eduroam, guest Wi-Fi).
//
// Layout of one room in the database:
//   rooms/{CODE}/meta                 { at, open }          written by the big screen
//   rooms/{CODE}/cfg                  question, sides, lock  written by the big screen
//   rooms/{CODE}/crowd                { d, tally, ids }      written by the big screen, 1×/s
//   rooms/{CODE}/players/{pid}        { name, x, y, placed, conn, online }   written by that phone
//   rooms/{CODE}/inbox/{pid}/{conn}   one message to one phone (welcome, kicked, …)
//
// The big screen stays the "brain" (history, replay, results). This file only
// turns database changes into the same messages the peer-to-peer version sends,
// so the rest of the app doesn't care which transport is used.

import { FIREBASE } from './config.js';
import { makeId } from './shared.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.6.0/';
const POS_MIN_MS = 150; // phones write their position at most ~7×/s

let fbPromise = null;
function loadFirebase() {
  if (!fbPromise) {
    fbPromise = (async () => {
      const [{ initializeApp }, dbm] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-database.js')]);
      const app = initializeApp({ ...FIREBASE });
      return { db: dbm.getDatabase(app), ...dbm };
    })().catch((e) => {
      fbPromise = null;
      throw e;
    });
  }
  return fbPromise;
}

const isDenied = (e) => /permission/i.test(String(e?.code || e?.message || e));
const safeKey = (s) => String(s || '').replace(/[.#$/[\]]/g, '').slice(0, 40);

/* ======================================================================= */

export class FbHostNet {
  /**
   * @param {string} code
   * @param {object} h handlers: onReady, onError, onStatus, onConnect, onMessage, onDisconnect
   * @param {{resume?: boolean}} opts resume = take over an existing room instead of creating one
   */
  constructor(code, h, opts = {}) {
    this.code = code;
    this.h = h;
    this.resume = !!opts.resume;
    this.players = new Map(); // pid -> { cid, conn, name, x, y, placed, online }
    this.unsubs = [];
    this.dead = false;
    this.seq = 0;
    this.lastCfg = '';
    this.batch = null;
  }

  async start() {
    let fb;
    try {
      fb = await loadFirebase();
    } catch {
      this.h.onStatus?.('reconnecting');
      this.retry = setTimeout(() => !this.dead && this.start(), 4000);
      return;
    }
    if (this.dead) return;
    this.fb = fb;
    const { db, ref, get, set, update, onValue, onChildAdded, onChildChanged, onChildRemoved } = fb;
    const base = `rooms/${this.code}`;

    // Claim the room (or take it back after a reload).
    try {
      if (this.resume) {
        await update(ref(db, `${base}/meta`), { at: Date.now(), open: true });
      } else {
        const meta = await get(ref(db, `${base}/meta`));
        if (meta.exists() && Date.now() - (meta.val()?.at || 0) < 24 * 3600e3) {
          this.h.onError?.('taken');
          return;
        }
        await set(ref(db, base), { meta: { at: Date.now(), open: true } });
      }
    } catch (e) {
      if (isDenied(e)) {
        this.h.onStatus?.('denied');
        return;
      }
      this.h.onStatus?.('reconnecting'); // offline: try again shortly
      this.retry = setTimeout(() => !this.dead && this.start(), 3000);
      return;
    }
    if (this.dead) return;

    this.unsubs.push(
      onValue(ref(db, '.info/connected'), (s) => {
        if (this.dead) return;
        const up = !!s.val();
        this.h.onStatus?.(up ? 'online' : 'reconnecting');
        if (up) this.h.onReady?.();
      })
    );
    const players = ref(db, `${base}/players`);
    const fail = (e) => isDenied(e) && this.h.onStatus?.('denied');
    this.unsubs.push(onChildAdded(players, (s) => this._player(s.key, s.val()), fail));
    this.unsubs.push(onChildChanged(players, (s) => this._player(s.key, s.val()), fail));
    this.unsubs.push(onChildRemoved(players, (s) => this._gone(s.key), fail));

    // Presence is tracked by the database itself; tell the app everyone online is alive.
    this.tick = setInterval(() => {
      for (const p of this.players.values()) if (p.online) this.h.onMessage?.(p.cid, { t: 'ping' });
    }, 4000);
  }

  _player(pid, v) {
    if (this.dead || !v || typeof v !== 'object' || typeof v.name !== 'string') return;
    const conn = String(v.conn || '');
    const cid = `${pid}|${conn}`;
    const online = v.online !== false;
    const x = +v.x, y = +v.y, placed = !!v.placed;
    const hello = () => this.h.onMessage?.(cid, { t: 'hello', pid, name: v.name, x, y, placed });
    let p = this.players.get(pid);

    if (!p || p.conn !== conn) {
      // New person, or the same person after reloading the page / on another tab.
      p = { cid, conn, name: v.name, x, y, placed, online };
      this.players.set(pid, p);
      if (online) {
        this.h.onConnect?.(cid);
        hello();
      }
      return;
    }
    if (online && !p.online) {
      p.online = true;
      this.h.onConnect?.(cid);
      hello();
    } else if (!online && p.online) {
      p.online = false;
      this.h.onDisconnect?.(cid);
    } else if (online && v.name !== p.name) {
      hello(); // renamed
    }
    if (online && placed && (x !== p.x || y !== p.y || !p.placed)) this.h.onMessage?.(cid, { t: 'pos', x, y });
    Object.assign(p, { name: v.name, x, y, placed });
  }

  _gone(pid) {
    const p = this.players.get(pid);
    this.players.delete(pid);
    if (p?.online) this.h.onDisconnect?.(p.cid);
  }

  send(cid, msg) {
    if (!this.fb || this.dead) return false;
    const { db, ref, set } = this.fb;
    const [pid, conn] = String(cid).split('|');
    const base = `rooms/${this.code}`;
    if (msg.t === 'crowd') {
      // The app sends the crowd to every phone; write it once for everyone.
      if (!this.batch) {
        this.batch = { d: msg.d || null, tally: msg.tally || null, ids: {} };
        queueMicrotask(() => {
          const b = this.batch;
          this.batch = null;
          set(ref(db, `${base}/crowd`), { ...b, at: Date.now() }).catch(() => {});
        });
      }
      if (msg.me >= 0) this.batch.ids[pid] = msg.me;
      return true;
    }
    if (msg.t === 'cfg' || msg.t === 'welcome') this._writeCfg(msg.cfg);
    if (msg.t === 'cfg') return true;
    set(ref(db, `${base}/inbox/${safeKey(pid)}/${safeKey(conn)}`), { ...msg, n: ++this.seq, at: Date.now() }).catch(() => {});
    return true;
  }

  _writeCfg(cfg) {
    if (!cfg) return;
    const s = JSON.stringify(cfg);
    if (s === this.lastCfg) return;
    this.lastCfg = s;
    const { db, ref, set } = this.fb;
    set(ref(db, `rooms/${this.code}/cfg`), cfg).catch(() => {
      this.lastCfg = '';
    });
  }

  /** Called by the app after removing someone from the room. */
  close(cid) {
    const [pid] = String(cid).split('|');
    const p = this.players.get(pid);
    if (!p || p.cid !== cid || !this.fb) return; // an old tab of someone who reloaded: nothing to do
    const { db, ref, remove } = this.fb;
    remove(ref(db, `rooms/${this.code}/players/${safeKey(pid)}`)).catch(() => {});
  }

  get size() {
    let n = 0;
    for (const p of this.players.values()) if (p.online) n++;
    return n;
  }
  get relayed() {
    return 0;
  }
  get note() {
    return '';
  }
  get degraded() {
    return false;
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.retry);
    clearInterval(this.tick);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}

/* ======================================================================= */

export class FbClientNet {
  /**
   * status: 'connecting' | 'connected' | 'reconnecting' | 'notfound' | 'offline' | 'denied'
   */
  constructor(code, h) {
    this.code = code;
    this.h = h;
    this.conn = makeId(); // one per page load
    this.pid = null;
    this.status = 'idle';
    this.stopped = false;
    this.lastOk = Date.now();
    this.dbUp = false;
    this.metaKnown = false;
    this.metaOk = false;
    this.opened = false;
    this.pending = null;
    this.lastWrite = 0;
    this.timer = null;
    this.unsubs = [];
    this.via = 'server';
  }

  async start() {
    this._set('connecting');
    let fb;
    try {
      fb = await loadFirebase();
    } catch {
      this._set('offline');
      this.retry = setTimeout(() => !this.stopped && this.start(), 4000);
      return;
    }
    if (this.stopped) return;
    this.fb = fb;
    const { db, ref, onValue } = fb;
    const base = `rooms/${this.code}`;
    const fail = (e) => isDenied(e) && this._set('denied');
    this.unsubs.push(
      onValue(ref(db, '.info/connected'), (s) => {
        this.dbUp = !!s.val();
        this._eval();
      }),
      onValue(
        ref(db, `${base}/meta`),
        (s) => {
          this.metaKnown = true;
          this.metaOk = s.exists();
          this._eval();
        },
        fail
      ),
      onValue(
        ref(db, `${base}/cfg`),
        (s) => {
          const cfg = s.val();
          if (cfg) this.h.onMessage?.({ t: 'cfg', cfg });
        },
        fail
      ),
      onValue(
        ref(db, `${base}/crowd`),
        (s) => {
          const c = s.val();
          if (!c) return;
          const me = this.pid && c.ids && c.ids[this.pid] != null ? c.ids[this.pid] : -1;
          this.h.onMessage?.({ t: 'crowd', d: c.d || null, me, tally: c.tally || null });
        },
        fail
      )
    );
    this.watch = setInterval(() => {
      if (this.status === 'connected') this.lastOk = Date.now();
    }, 1500);
  }

  _eval() {
    if (this.stopped || this.status === 'denied') return;
    if (!this.dbUp) {
      this._set(navigator.onLine === false ? 'offline' : this.opened ? 'reconnecting' : 'connecting');
      return;
    }
    if (!this.metaKnown) return;
    if (!this.metaOk) {
      this._set('notfound');
      return;
    }
    if (this.status !== 'connected') {
      this._set('connected');
      this.opened = true;
      this.h.onOpen?.(); // the app answers with a 'hello'
    }
  }

  get downFor() {
    return this.status === 'connected' ? 0 : Date.now() - this.lastOk;
  }

  _set(s) {
    if (this.status === s) return;
    if (this.status === 'connected') this.lastOk = Date.now();
    this.status = s;
    this.h.onStatus?.(s);
  }

  send(msg) {
    if (!this.fb || this.stopped || this.status !== 'connected') return false;
    const { db, ref, update, set, onValue, onDisconnect } = this.fb;
    if (msg.t === 'hello') {
      this.pid = safeKey(msg.pid);
      const me = ref(db, `rooms/${this.code}/players/${this.pid}`);
      const online = ref(db, `rooms/${this.code}/players/${this.pid}/online`);
      // If this phone loses its connection, the database marks it offline by itself.
      onDisconnect(online).set(false).catch(() => {});
      update(me, {
        name: String(msg.name || 'Guest').slice(0, 24),
        x: +msg.x || 0.5,
        y: +msg.y || 0.5,
        placed: !!msg.placed,
        conn: this.conn,
        online: true,
      }).catch(() => {});
      if (!this.inboxOn) {
        this.inboxOn = true;
        this.unsubs.push(
          onValue(ref(db, `rooms/${this.code}/inbox/${this.pid}/${this.conn}`), (s) => {
            const m = s.val();
            if (m && m.t) this.h.onMessage?.(m);
          }),
          // An older tab of ours going away may mark us offline: say we're still here.
          onValue(online, (s) => {
            if (s.val() === false && this.status === 'connected' && !this.stopped) set(online, true).catch(() => {});
          })
        );
      }
      return true;
    }
    if (msg.t === 'pos') {
      if (!this.pid) return false;
      this.pending = { x: +msg.x, y: +msg.y };
      const wait = POS_MIN_MS - (Date.now() - this.lastWrite);
      if (wait <= 0) this._flush();
      else if (!this.timer) this.timer = setTimeout(() => this._flush(), wait);
      return true;
    }
    return true; // 'ping' etc.: presence is handled by the database
  }

  _flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending || !this.pid || this.stopped) return;
    const { db, ref, update } = this.fb;
    update(ref(db, `rooms/${this.code}/players/${this.pid}`), { ...this.pending, placed: true }).catch(() => {});
    this.pending = null;
    this.lastWrite = Date.now();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.timer);
    clearInterval(this.watch);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.fb && this.pid) {
      const { db, ref, onDisconnect } = this.fb;
      onDisconnect(ref(db, `rooms/${this.code}/players/${this.pid}/online`))
        .cancel()
        .catch(() => {});
    }
  }
}
