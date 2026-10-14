'use strict';

// Audio levels for the visualizer. Sidra exposes no audio data over MPRIS, so this records
// Sidra's own output stream from the sound server (PipeWire via pipewire-pulse, or PulseAudio)
// with `parec --monitor-stream`, which taps one app's stream without touching what you hear.
// Falls back to everything playing (the default output's monitor) when asked to, or when
// only PipeWire's own `pw-record` is installed.

const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');

const RATE = 22050;
const FFT_SIZE = 1024; // ~46 ms window at 22.05 kHz
const BANDS = 16;
const MIN_HZ = 50;
const MAX_HZ = 10000;

// ---------------------------------------------------------------- spectrum maths

function makeFft(n) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const out = new Float64Array(n / 2 + 1); // reused: callers read it before the next call

  /** Magnitudes of bins 0..n/2 for n real samples (already scaled to -1..1). */
  return function magnitudes(samples) {
    for (let i = 0; i < n; i++) {
      re[rev[i]] = samples[i] * window[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = start + j;
          const b = a + half;
          const tr = re[b] * cos[k] + im[b] * sin[k];
          const ti = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / (n / 4); // Hann gain ≈ 0.5
    return out;
  };
}

/** Log-spaced band edges as FFT bin indices. */
function bandEdges(bands = BANDS, rate = RATE, n = FFT_SIZE) {
  const binHz = rate / n;
  const edges = [];
  for (let i = 0; i <= bands; i++) {
    const hz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / bands);
    edges.push(Math.max(1, Math.round(hz / binHz)));
  }
  for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
  return edges;
}

/**
 * Turns sample windows into 0..1 bar heights: band energy in dB with a gentle treble lift
 * (music falls off with frequency), a slowly adapting ceiling so quiet and loud songs both
 * move, and fast-attack / slow-release smoothing so bars bounce instead of flicker.
 */
class Analyser {
  constructor({ bands = BANDS, rate = RATE, size = FFT_SIZE } = {}) {
    this.size = size;
    this.fft = makeFft(size);
    this.edges = bandEdges(bands, rate, size);
    this.levels = new Float64Array(bands);
    this.raw = new Float64Array(bands);
    this.ceiling = -18; // dB, adapts to the music
    this.range = 42; // dB shown between floor and ceiling
  }

  reset() {
    this.levels.fill(0);
  }

  update(samples) {
    const mags = this.fft(samples);
    const bands = this.levels.length;
    const raw = this.raw;
    let loudest = -Infinity;
    for (let b = 0; b < bands; b++) {
      let sum = 0;
      const lo = this.edges[b];
      const hi = this.edges[b + 1];
      for (let k = lo; k < hi; k++) sum += mags[k] * mags[k];
      const rms = Math.sqrt(sum / Math.max(1, hi - lo));
      const tilt = 3 * Math.log2(Math.max(1, b + 1)); // +3 dB per band-doubling
      raw[b] = 20 * Math.log10(rms + 1e-9) + tilt;
      if (raw[b] > loudest) loudest = raw[b];
    }
    // Ceiling follows the loudest band: jumps up, drifts down over a few seconds.
    if (loudest > this.ceiling) this.ceiling = loudest;
    else this.ceiling = Math.max(-60, this.ceiling - 0.25);
    for (let b = 0; b < bands; b++) {
      const v = Math.min(1, Math.max(0, (raw[b] - (this.ceiling - this.range)) / this.range));
      const prev = this.levels[b];
      this.levels[b] = v > prev ? prev + (v - prev) * 0.7 : prev + (v - prev) * 0.25;
    }
    return this.levels;
  }

  /** Let bars fall back to rest when no audio is arriving. */
  decay() {
    for (let b = 0; b < this.levels.length; b++) this.levels[b] *= 0.7;
    return this.levels;
  }
}

// ---------------------------------------------------------------- finding Sidra's stream

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function looksLikeSidra(props) {
  const lc = (k) => String(props[k] || '').toLowerCase();
  return (
    lc('application.name') === 'sidra' ||
    lc('application.process.binary') === 'sidra' ||
    lc('application.icon_name') === 'sidra' ||
    lc('application.id') === 'sidra' ||
    lc('pipewire.access.portal.app_id') === 'sidra'
  );
}

/** Parse `pactl list sink-inputs` text output (for pactl older than 16, which lacks -f json). */
function parsePactlText(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const head = /^Sink Input #(\d+)/.exec(line);
    if (head) {
      cur = { index: Number(head[1]), corked: false, properties: {} };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const corked = /^\s*Corked:\s*(\w+)/.exec(line);
    if (corked) cur.corked = /yes/i.test(corked[1]);
    const prop = /^\s+([\w.-]+) = "(.*)"$/.exec(line);
    if (prop) cur.properties[prop[1]] = prop[2];
  }
  return out;
}

async function listSinkInputs() {
  try {
    const json = await run('pactl', ['-f', 'json', 'list', 'sink-inputs']);
    const list = JSON.parse(json);
    return list.map((s) => ({ index: s.index, corked: Boolean(s.corked), properties: s.properties || {} }));
  } catch (err) {
    if (err.code === 'ENOENT') throw err;
    return parsePactlText(await run('pactl', ['list', 'sink-inputs']));
  }
}

/** Index of Sidra's playing stream, preferring one that isn't corked (paused). */
async function findSidraStream() {
  const streams = (await listSinkInputs()).filter((s) => looksLikeSidra(s.properties));
  if (!streams.length) return null;
  return (streams.find((s) => !s.corked) || streams[0]).index;
}

// ---------------------------------------------------------------- capture

/**
 * One shared meter. `start(source)` begins capturing ('sidra' or 'all'), `stop()` ends it.
 * `levels()` returns the latest bar heights; `status` says what it's doing for the settings panel.
 */
class AudioMeter extends EventEmitter {
  constructor({ log = () => {}, bands = BANDS } = {}) {
    super();
    this.log = log;
    this.analyser = new Analyser({ bands });
    this.ring = new Float64Array(FFT_SIZE);
    this.window = new Float64Array(FFT_SIZE); // reused for each analysis
    this.ringPos = 0;
    this.fresh = 0; // samples received since the last analysis
    this.lastData = 0;
    this.child = null;
    this.wanted = false;
    this.source = 'sidra';
    this.retry = null;
    this.status = { state: 'off', message: 'Visualizer is off' };
    this.loggedMissing = false;
  }

  _setStatus(state, message) {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    this.emit('status', this.status);
  }

  start(source = 'sidra') {
    if (this.wanted && this.source === source && (this.child || this.retry)) return;
    if (this.child && this.source !== source) this._kill();
    this.wanted = true;
    this.source = source;
    if (!this.child && !this.retry) this._open();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retry);
    this.retry = null;
    this._kill();
    this.analyser.reset();
    this._setStatus('off', 'Visualizer is idle (nothing playing)');
  }

  _kill() {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    c.removeAllListeners('exit');
    try {
      c.kill('SIGTERM');
    } catch {}
  }

  _later(ms) {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.child) this._open();
    }, ms);
  }

  async _open() {
    if (!this.wanted) return;
    let args;
    let cmd = 'parec';
    try {
      if (this.source === 'sidra') {
        const index = await findSidraStream();
        if (!this.wanted || this.child) return;
        if (index === null) {
          this._setStatus('waiting', "Waiting for Sidra's audio stream");
          this._later(2000);
          return;
        }
        args = [`--monitor-stream=${index}`];
      } else {
        args = ['-d', '@DEFAULT_MONITOR@'];
      }
    } catch (err) {
      if (err.code === 'ENOENT' && this.source === 'sidra') {
        // No pactl: can't single Sidra out. Use PipeWire's recorder on everything instead.
        return this._openPipeWire('pactl (from libpulse / pulseaudio-utils) is needed to listen to Sidra alone');
      }
      this._setStatus('error', `Couldn't list audio streams: ${err.message}`);
      this._later(5000);
      return;
    }
    this._spawn(cmd, [...args, '--format=s16le', `--rate=${RATE}`, '--channels=1', '--latency-msec=30', '--client-name=Sidra Companion visualizer'], () =>
      this._openPipeWire('parec (from libpulse / pulseaudio-utils) not found'),
    );
  }

  _openPipeWire(why) {
    this._spawn(
      'pw-record',
      ['-P', 'stream.capture.sink=true', '--rate', String(RATE), '--channels', '1', '--format', 's16', '--latency', '30ms', '-'],
      () => {
        this._setStatus('error', `Can't capture audio: ${why}, and pw-record isn't installed either.`);
        if (!this.loggedMissing) this.log(`Visualizer: ${this.status.message}`);
        this.loggedMissing = true;
        this._later(30000);
      },
      `Listening to everything playing (${why})`,
    );
  }

  _spawn(cmd, args, onMissing, note) {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      onMissing();
      return;
    }
    this.child = child;
    let errText = '';
    let carry = null;
    child.on('error', (err) => {
      if (this.child === child) this.child = null;
      if (err.code === 'ENOENT') onMissing();
      else {
        this._setStatus('error', `${cmd}: ${err.message}`);
        this._later(5000);
      }
    });
    child.stderr.on('data', (d) => (errText = (errText + d).slice(-400)));
    child.stdout.on('data', (buf) => {
      if (this.child !== child) return; // stopped or replaced; ignore audio still in flight
      if (carry) {
        buf = Buffer.concat([carry, buf]);
        carry = null;
      }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) carry = buf.subarray(usable);
      for (let i = 0; i < usable; i += 2) {
        this.ring[this.ringPos] = buf.readInt16LE(i) / 32768;
        this.ringPos = (this.ringPos + 1) % FFT_SIZE;
      }
      this.fresh += usable / 2;
      this.lastData = Date.now();
      if (this.status.state !== 'capturing') {
        this._setStatus(
          'capturing',
          note || (this.source === 'sidra' ? "Listening to Sidra's audio" : 'Listening to everything playing'),
        );
      }
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) return;
      // Sidra's stream ends when it stops or changes output; look for it again.
      if (code && this.status.state !== 'capturing') this._setStatus('error', `${cmd} exited (${code}): ${errText.trim().split('\n').pop() || 'no output'}`);
      this._later(1500);
    });
  }

  /** Current bar heights (0..1). Analyses the newest window if new audio arrived. */
  levels() {
    if (Date.now() - this.lastData > 300) return this.analyser.decay();
    if (this.fresh > 0) {
      this.fresh = 0;
      const win = this.window;
      for (let i = 0; i < FFT_SIZE; i++) win[i] = this.ring[(this.ringPos + i) % FFT_SIZE];
      return this.analyser.update(win);
    }
    return this.analyser.levels;
  }

  /** True while audio is actually arriving. */
  get live() {
    return this.status.state === 'capturing' && Date.now() - this.lastData < 1000;
  }
}

module.exports = { AudioMeter, Analyser, makeFft, bandEdges, looksLikeSidra, parsePactlText, findSidraStream, RATE, FFT_SIZE, BANDS };
