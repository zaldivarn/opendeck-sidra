'use strict';

// Thin client for the Stream Deck SDK v2 WebSocket protocol, which OpenDeck speaks.
// OpenDeck launches the plugin as:
//   node bin/plugin.js -port <n> -pluginUUID <uuid> -registerEvent registerPlugin -info <json>

const { EventEmitter } = require('events');
const WebSocket = require('ws');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && i + 1 < argv.length) {
      out[a.replace(/^-+/, '')] = argv[i + 1];
      i++;
    }
  }
  return out;
}

class OpenDeck extends EventEmitter {
  constructor(argv = process.argv.slice(2)) {
    super();
    const args = parseArgs(argv);
    this.port = Number(args.port);
    this.uuid = args.pluginUUID;
    this.registerEvent = args.registerEvent || 'registerPlugin';
    try {
      this.info = args.info ? JSON.parse(args.info) : {};
    } catch {
      this.info = {};
    }
    if (!this.port || !this.uuid) {
      throw new Error('Missing -port / -pluginUUID. This file is meant to be launched by OpenDeck.');
    }
    this._lastImage = new Map();
    this._lastTitle = new Map();
    this._lastState = new Map();
  }

  connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws.on('open', () => {
      this._send({ event: this.registerEvent, uuid: this.uuid });
      this.emit('connected');
    });
    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.event) this.emit(msg.event, msg);
    });
    this.ws.on('close', () => this.emit('disconnected'));
    this.ws.on('error', (err) => this.emit('socketError', err));
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Forget cached render state so the next set* call always goes out (used on willAppear). */
  resetContext(context) {
    this._lastImage.delete(context);
    this._lastTitle.delete(context);
    this._lastState.delete(context);
  }

  setImage(context, image, state) {
    const key = state === undefined ? context : `${context}|${state}`;
    if (this._lastImage.get(key) === image) return;
    this._lastImage.set(key, image);
    const payload = { image, target: 0 };
    if (state !== undefined) payload.state = state;
    this._send({ event: 'setImage', context, payload });
  }

  setTitle(context, title, state) {
    const key = state === undefined ? context : `${context}|${state}`;
    if (this._lastTitle.get(key) === title) return;
    this._lastTitle.set(key, title);
    const payload = { title, target: 0 };
    if (state !== undefined) payload.state = state;
    this._send({ event: 'setTitle', context, payload });
  }

  setState(context, state) {
    if (this._lastState.get(context) === state) return;
    this._lastState.set(context, state);
    this._send({ event: 'setState', context, payload: { state } });
  }

  showOk(context) {
    this._send({ event: 'showOk', context });
  }

  showAlert(context) {
    this._send({ event: 'showAlert', context });
  }

  setSettings(context, settings) {
    this._send({ event: 'setSettings', context, payload: settings });
  }

  getGlobalSettings() {
    this._send({ event: 'getGlobalSettings', context: this.uuid });
  }

  setGlobalSettings(settings) {
    this._send({ event: 'setGlobalSettings', context: this.uuid, payload: settings });
  }

  sendToPropertyInspector(context, action, payload) {
    this._send({ event: 'sendToPropertyInspector', context, action, payload });
  }

  /** Write to the plugin's own log file (stdout) and OpenDeck's main log (which adds "[Sidra]"). */
  log(message) {
    console.log(`${new Date().toISOString()} ${message}`);
    this._send({ event: 'logMessage', payload: { message } });
  }
}

module.exports = { OpenDeck, parseArgs };
