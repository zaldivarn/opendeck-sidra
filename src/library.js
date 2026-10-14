'use strict';

// "Add to Library" is not part of MPRIS, so this reaches into Sidra's Apple Music page over
// the Chrome DevTools Protocol and asks MusicKit (already signed in as you) to do it.
// Sidra has to be started with --remote-debugging-port=<port> for this to work; see README.

const WebSocket = require('ws');

const APPLE_PAGE = /^https:\/\/(classical\.)?music\.apple\.com\//;

class LibraryError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Runs inside music.apple.com. Kept as a plain function so it can be serialised with
// toString(); it must not reference anything from this module.
/* eslint-disable no-undef */
async function pageScript(mode) {
  const mk = window.MusicKit && MusicKit.getInstance && MusicKit.getInstance();
  if (!mk) return { ok: false, error: 'MusicKit is not ready in Sidra yet' };
  const item = mk.nowPlayingItem;
  if (!item) return { ok: false, error: 'Nothing is playing' };
  const attrs = item.attributes || {};
  const pp = item.playParams || attrs.playParams || {};
  const kind = String(pp.kind || item.type || '');
  const title = attrs.name || item.title || '';
  const itemId = String(item.id || '');
  if (/radio|station|episode/i.test(kind)) {
    return { ok: false, itemId, title, error: 'Radio stations and shows cannot be added to the library' };
  }
  if (pp.isLibrary || /^i\./.test(itemId)) return { ok: true, itemId, title, inLibrary: true, already: true };
  const type = /video/i.test(kind) ? 'music-videos' : 'songs';
  const catalogId = String(pp.catalogId || (/^\d+$/.test(itemId) ? itemId : ''));
  if (!catalogId) return { ok: false, itemId, title, error: 'This item has no Apple Music catalogue ID' };

  async function call(path, params, method) {
    // MusicKit's own wrapper knows the right host and tokens; fall back to amp-api directly.
    if (mk.api && typeof mk.api.music === 'function') {
      try {
        const r = await mk.api.music(path, params, method ? { fetchOptions: { method } } : undefined);
        return { status: (r && r.response && r.response.status) || 200, data: r && r.data, via: 'musickit' };
      } catch (e) {
        /* fall through to a direct request so we get a real HTTP status */
      }
    }
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`https://amp-api.music.apple.com${path}${qs ? `?${qs}` : ''}`, {
      method: method || 'GET',
      headers: { Authorization: `Bearer ${mk.developerToken}`, 'Music-User-Token': mk.musicUserToken || '' },
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {}
    return { status: res.status, data, via: 'fetch' };
  }

  if (mode === 'check') {
    const sf = mk.storefrontId || mk.storefrontCountryCode || 'us';
    const r = await call(`/v1/catalog/${sf}/${type}/${catalogId}`, { relate: 'library' });
    const rel = r.data && r.data.data && r.data.data[0] && r.data.data[0].relationships;
    const lib = rel && rel.library && rel.library.data;
    return { ok: r.status < 300, itemId, title, inLibrary: Array.isArray(lib) ? lib.length > 0 : null, status: r.status };
  }

  const r = await call('/v1/me/library', { [`ids[${type}]`]: catalogId }, 'POST');
  const ok = r.status >= 200 && r.status < 300;
  return {
    ok,
    itemId,
    title,
    inLibrary: ok ? true : null,
    status: r.status,
    via: r.via,
    error: ok ? undefined : `Apple Music API returned HTTP ${r.status}`,
  };
}
/* eslint-enable no-undef */

async function findSidraPage(port) {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    targets = await res.json();
  } catch (err) {
    const refused = /ECONNREFUSED|fetch failed/i.test(`${err.message} ${err.cause ? err.cause.code : ''}`);
    throw new LibraryError(
      refused
        ? `Nothing is listening on 127.0.0.1:${port}. Start Sidra with --remote-debugging-port=${port} to enable Add to Library.`
        : `DevTools endpoint on port ${port} did not answer: ${err.message}`,
      'NO_CDP',
    );
  }
  const page = (targets || []).find((t) => t.type === 'page' && APPLE_PAGE.test(t.url || '') && t.webSocketDebuggerUrl);
  if (!page) {
    throw new LibraryError(`Port ${port} answered, but no Apple Music page was found there. Is that Sidra?`, 'NO_PAGE');
  }
  return page;
}

function evaluate(wsUrl, expression, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new LibraryError('Timed out waiting for Sidra', 'TIMEOUT'));
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) return reject(new LibraryError(msg.error.message || 'CDP error', 'CDP'));
      const r = msg.result || {};
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        return reject(new LibraryError((d.exception && d.exception.description) || d.text || 'Script error in Sidra', 'SCRIPT'));
      }
      resolve(r.result ? r.result.value : undefined);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new LibraryError(`DevTools socket error: ${err.message}`, 'CDP'));
    });
  });
}

class LibraryClient {
  constructor({ getPort = () => 9222 } = {}) {
    this.getPort = getPort;
    this._busy = null;
  }

  async _run(mode) {
    const page = await findSidraPage(this.getPort());
    const expression = `(${pageScript.toString()})(${JSON.stringify(mode)})`;
    const value = await evaluate(page.webSocketDebuggerUrl, expression);
    if (!value || typeof value !== 'object') throw new LibraryError('Unexpected reply from Sidra', 'SCRIPT');
    return value;
  }

  /** Add the current track. Resolves to the page result; rejects with LibraryError. */
  add() {
    // Collapse double-presses into one request.
    if (!this._busy) this._busy = this._run('add').finally(() => (this._busy = null));
    return this._busy;
  }

  /** Best-effort: is the current track already in the library? */
  check() {
    return this._run('check');
  }

  /** For the settings page: can we reach Sidra's page at all? */
  async probe() {
    const page = await findSidraPage(this.getPort());
    return { url: page.url, title: page.title };
  }
}

module.exports = { LibraryClient, LibraryError, pageScript };
