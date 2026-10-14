'use strict';

// Sidra exposes a bi-directional MPRIS service on the D-Bus session bus as
// org.mpris.MediaPlayer2.sidra. This module watches for it to appear and disappear,
// mirrors the player state, and sends transport commands.

const { EventEmitter } = require('events');
const fs = require('fs');
const dbus = require('dbus-next');

const { Variant } = dbus;

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

class SidraNotRunning extends Error {
  constructor() {
    super('Sidra is not running (no org.mpris.MediaPlayer2.sidra on the session bus)');
    this.name = 'SidraNotRunning';
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function unwrap(value) {
  if (value instanceof Variant) return unwrap(value.value);
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unwrap(v);
    return out;
  }
  return value;
}

/** Turn the raw xesam/mpris dictionary into the handful of fields the keys need. */
function parseMetadata(raw) {
  const m = unwrap(raw || {});
  const artist = Array.isArray(m['xesam:artist']) ? m['xesam:artist'].filter(Boolean).join(', ') : m['xesam:artist'] || '';
  const trackPath = m['mpris:trackid'] || '';
  const trackId = /\/track\/(.+)$/.exec(trackPath)?.[1] || '';
  const title = m['xesam:title'] || '';
  return {
    trackPath,
    trackId,
    title,
    artist,
    album: m['xesam:album'] || '',
    artUrl: m['mpris:artUrl'] || '',
    url: m['xesam:url'] || '',
    lengthUs: Number(m['mpris:length'] || 0),
    // A track key that also changes when radio songs change under one station track id.
    key: `${trackPath}|${title}|${artist}`,
  };
}

/**
 * dbus-next only understands path= sockets natively (abstract sockets need a native
 * add-on). Node can open Linux abstract sockets itself if the path starts with NUL, so
 * rewrite abstract addresses into socket= form, and fall back to the systemd user bus.
 */
function resolveBusAddress() {
  const env = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (env) {
    const first = env.split(';')[0];
    const abs = /^unix:.*\babstract=([^,]+)/.exec(first);
    if (abs) return `unix:socket=\u0000${abs[1]}`;
    return env;
  }
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  if (fs.existsSync(`${runtime}/bus`)) return `unix:path=${runtime}/bus`;
  return undefined; // let dbus-next try X11 discovery
}

class SidraPlayer extends EventEmitter {
  constructor({ log = () => {}, busName = 'org.mpris.MediaPlayer2.sidra' } = {}) {
    super();
    this.log = log;
    this.busName = busName;
    this.bus = null;
    this.current = null; // { name, obj, player, props, root }
    this.state = SidraPlayer.emptyState();
    this._attachSeq = 0;
    this._reconnectTimer = null;
    // False until the first look for Sidra on the bus has finished, so keys can avoid
    // flashing "Sidra closed" while OpenDeck is still starting up.
    this.ready = false;
  }

  _markReady() {
    if (this.ready) return;
    this.ready = true;
    this.emit('change', this.state, { ready: true, running: true });
  }

  static emptyState() {
    return {
      running: false,
      status: 'Stopped',
      shuffle: false,
      canControl: false,
      metadata: parseMetadata({}),
    };
  }

  matchesName(name) {
    return name === this.busName || name.startsWith(`${this.busName}.`);
  }

  async start() {
    try {
      this.bus = dbus.sessionBus({ busAddress: resolveBusAddress() });
      this.bus.on('error', (err) => this._onBusError(err));
      const obj = await withTimeout(this.bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus'), 5000, 'D-Bus hello');
      this.dbusIface = obj.getInterface('org.freedesktop.DBus');
      this.dbusIface.on('NameOwnerChanged', (name, oldOwner, newOwner) => {
        if (!name.startsWith(MPRIS_PREFIX) || !this.matchesName(name)) return;
        if (newOwner) {
          this.log(`Sidra appeared on the bus as ${name}`);
          this._attach(name);
        } else if (this.current && this.current.name === name) {
          this.log('Sidra left the bus');
          this._detach();
        }
      });
      const names = await this.dbusIface.ListNames();
      const found = names.find((n) => this.matchesName(n));
      if (found) await this._attach(found);
      else this.log('Waiting for Sidra to start…');
      this._markReady();
    } catch (err) {
      this._onBusError(err);
      this._markReady();
    }
  }

  _onBusError(err) {
    this.log(`D-Bus error: ${err && err.message ? err.message : err}`);
    this._detach();
    try {
      this.bus && this.bus.disconnect();
    } catch {}
    this.bus = null;
    if (!this._reconnectTimer) {
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.start();
      }, 5000);
    }
  }

  async _attach(name) {
    const seq = ++this._attachSeq;
    this._detach(false);
    try {
      const obj = await withTimeout(this.bus.getProxyObject(name, OBJECT_PATH), 5000, 'MPRIS introspection');
      if (seq !== this._attachSeq) return;
      const player = obj.getInterface(PLAYER_IFACE);
      const props = obj.getInterface(PROPS_IFACE);
      let root = null;
      try {
        root = obj.getInterface(ROOT_IFACE);
      } catch {}
      const onChanged = (iface, changed) => {
        if (iface !== PLAYER_IFACE) return;
        this._applyProps(changed);
      };
      props.on('PropertiesChanged', onChanged);
      this.current = { name, obj, player, props, root, onChanged };
      const all = await withTimeout(props.GetAll(PLAYER_IFACE), 5000, 'MPRIS GetAll');
      if (seq !== this._attachSeq) return;
      this.state.running = true;
      this.log(`Connected to Sidra (${name})`);
      this._applyProps(all, true);
    } catch (err) {
      if (seq !== this._attachSeq) return;
      this.log(`Could not attach to ${name}: ${err.message}`);
      this._detach();
    }
  }

  _detach(emit = true) {
    if (this.current) {
      try {
        this.current.props.removeListener('PropertiesChanged', this.current.onChanged);
      } catch {}
      this.current = null;
    }
    const wasRunning = this.state.running;
    this.state = SidraPlayer.emptyState();
    if (emit && wasRunning) this.emit('change', this.state, { running: true, track: true, status: true, shuffle: true });
  }

  _applyProps(changedRaw, forceAll = false) {
    const changed = {};
    const prevKey = this.state.metadata.key;
    const prevArt = this.state.metadata.artUrl;
    for (const [prop, v] of Object.entries(changedRaw || {})) {
      const value = unwrap(v);
      switch (prop) {
        case 'PlaybackStatus':
          if (value !== this.state.status) changed.status = true;
          this.state.status = value;
          break;
        case 'Shuffle':
          if (Boolean(value) !== this.state.shuffle) changed.shuffle = true;
          this.state.shuffle = Boolean(value);
          break;
        case 'CanControl':
          this.state.canControl = Boolean(value);
          break;
        case 'Metadata': {
          const md = parseMetadata(v);
          this.state.metadata = md;
          if (md.key !== prevKey) changed.track = true;
          if (md.artUrl !== prevArt) changed.art = true;
          break;
        }
        default:
          break;
      }
    }
    if (forceAll) Object.assign(changed, { running: true, track: true, art: true, status: true, shuffle: true });
    if (Object.keys(changed).length) this.emit('change', this.state, changed);
  }

  _require() {
    if (!this.current) throw new SidraNotRunning();
    return this.current;
  }

  async _call(fn) {
    const c = this._require();
    return withTimeout(fn(c), 4000, 'MPRIS call');
  }

  play() {
    return this._call((c) => c.player.Play());
  }
  pause() {
    return this._call((c) => c.player.Pause());
  }
  playPause() {
    return this._call((c) => c.player.PlayPause());
  }
  next() {
    return this._call((c) => c.player.Next());
  }
  previous() {
    return this._call((c) => c.player.Previous());
  }
  /**
   * Back to the start of the current song. Per MPRIS (and Sidra's Seek), seeking back past
   * the start lands at 0:00, so a large negative offset works without knowing the position
   * or matching the track id.
   */
  restartTrack() {
    return this._call((c) => c.player.Seek(-24n * 3600n * 1000000n));
  }
  raise() {
    return this._call((c) => {
      if (!c.root) throw new Error('Sidra does not expose org.mpris.MediaPlayer2.Raise');
      return c.root.Raise();
    });
  }
  setShuffle(on) {
    return this._call((c) => c.props.Set(PLAYER_IFACE, 'Shuffle', new Variant('b', Boolean(on))));
  }
  async toggleShuffle() {
    const c = this._require();
    // Read the live value rather than the cached one so a stale cache cannot flip it twice.
    let current = this.state.shuffle;
    try {
      current = Boolean(unwrap(await withTimeout(c.props.Get(PLAYER_IFACE, 'Shuffle'), 2000, 'MPRIS Get')));
    } catch {}
    await this.setShuffle(!current);
    return !current;
  }
}

module.exports = { SidraPlayer, SidraNotRunning, parseMetadata, resolveBusAddress };
