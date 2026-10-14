'use strict';

// Album art: fetch (https) or read (file://) the cover Sidra publishes in mpris:artUrl,
// decode it, and build the composite key images.

const fs = require('fs/promises');
const { fileURLToPath } = require('url');
const raster = require('./raster');
const { isPng, decodePng } = require('./png');

const FETCH_SIZE = 288; // 2x the key canvas, box-filtered down for a crisp result

class LRU {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}

/** Ask Apple's CDN for a smaller rendition: .../512x512bb.jpg -> .../288x288bb.jpg */
function sizedArtworkUrl(url, size = FETCH_SIZE) {
  return url.replace(/\/\d+x\d+[a-z]{0,3}(-\d+)?\.(jpe?g|png|webp)(\?.*)?$/i, `/${size}x${size}bb.jpg`);
}

async function fetchBytes(url, timeoutMs = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadBytes(artUrl) {
  if (artUrl.startsWith('file://')) return fs.readFile(fileURLToPath(artUrl));
  if (artUrl.startsWith('/')) return fs.readFile(artUrl);
  if (/^https?:\/\//i.test(artUrl)) {
    const sized = sizedArtworkUrl(artUrl);
    if (sized !== artUrl) {
      try {
        return await fetchBytes(sized);
      } catch {
        // fall through to the URL exactly as Sidra published it
      }
    }
    return fetchBytes(artUrl);
  }
  throw new Error(`unsupported artUrl scheme: ${artUrl.slice(0, 32)}`);
}

function decode(bytes) {
  if (isPng(bytes)) return decodePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return raster.decodeJpeg(bytes);
  throw new Error('artwork is neither JPEG nor PNG');
}

class ArtCache {
  constructor(log = () => {}) {
    this.log = log;
    this.square = new LRU(24); // artUrl -> Promise<144x144 image|null>
    this.rendered = new LRU(64); // render key -> data URI
    this.ready = new LRU(24); // artUrl -> loaded 144x144 image (for per-frame drawing)
    this.accents = new LRU(24); // artUrl -> [r, g, b]
  }

  /** 144x144 RGBA cover, or null when it cannot be loaded. Never rejects. */
  cover(artUrl) {
    if (!artUrl) return Promise.resolve(null);
    let p = this.square.get(artUrl);
    if (!p) {
      p = loadBytes(artUrl)
        .then((bytes) => {
          const img = raster.resizeSquare(decode(bytes), raster.KEY_SIZE);
          this.ready.set(artUrl, img);
          return img;
        })
        .catch((err) => {
          this.log(`album art unavailable (${err.message}) for ${artUrl.slice(0, 80)}`);
          // Forget the failure so the next render (track or play-state change) retries.
          if (this.square.get(artUrl) === p) this.square.map.delete(artUrl);
          return null;
        });
      this.square.set(artUrl, p);
    }
    return p;
  }

  /** The cover if it's already loaded (starting a load if not), for drawing frames synchronously. */
  coverNow(artUrl) {
    if (!artUrl) return null;
    const img = this.ready.get(artUrl);
    if (!img) this.cover(artUrl);
    return img || null;
  }

  /** A vivid colour from the cover for the visualizer's "album colour" mode. */
  accent(artUrl) {
    let c = this.accents.get(artUrl);
    if (!c) {
      const img = this.coverNow(artUrl);
      if (!img) return null;
      c = raster.accentColour(img);
      this.accents.set(artUrl, c);
    }
    return c;
  }

  /** Darken behind the song text, wherever OpenDeck draws the title. */
  static applyShade(img, shade) {
    if (shade === 'bottom') raster.bottomShade(img, 0.5, 0.8);
    else if (shade === 'top') raster.topShade(img, 0.5, 0.8);
    else if (shade === 'middle') raster.middleShade(img, 0.55);
    return img;
  }

  /**
   * One visualizer frame (playing): the cover, the text shade if any, then the bars.
   * Synchronous and uncached — called every frame. Null until the cover has loaded.
   */
  vizFrame(artUrl, levels, { style = 'bottom', color = [255, 255, 255], shade = null } = {}) {
    const base = this.coverNow(artUrl);
    if (!base) return null;
    const img = ArtCache.applyShade(raster.cloneImage(base), shade);
    raster.drawBars(img, levels, { style, color });
    return raster.encodePng(img); // ~10x faster than JPEG here, and lossless
  }

  /**
   * Play/Pause key with the cover. While playing it is just the cover; while paused a
   * pause icon shows the state. Options:
   *   indicator: 'auto' (large centred pause icon, default) | 'badge' (small corner pause icon) | 'none'
   *              (the old 'center' value is treated as 'auto')
   *   dimWhenPaused: boolean
   *   shade: 'bottom' | 'top' | 'middle' | null — darken behind song text
   */
  async playPauseKey(artUrl, playing, { indicator = 'auto', dimWhenPaused = true, shade = null } = {}) {
    const key = `pp|${artUrl}|${playing}|${indicator}|${dimWhenPaused}|${shade}`;
    const hit = this.rendered.get(key);
    if (hit) return hit;
    const base = await this.cover(artUrl);
    if (!base) return null;
    const img = ArtCache.applyShade(raster.cloneImage(base), shade);
    const S = raster.KEY_SIZE;
    if (!playing) {
      if (dimWhenPaused) raster.dim(img, 0.45);
      if (indicator === 'badge') raster.drawBadge(img, 'pause', S - 26, S - 26, 19, 0.6);
      else if (indicator !== 'none') raster.drawBadge(img, 'pause', S / 2, S / 2, 34, 0.5);
    }
    const uri = raster.encodeJpeg(img, 90);
    this.rendered.set(key, uri);
    return uri;
  }

  /** Dimmed cover used behind the Song Display text. */
  async songBackground(artUrl, brightness = 0.4) {
    const key = `bg|${artUrl}|${brightness}`;
    const hit = this.rendered.get(key);
    if (hit) return hit;
    const base = await this.cover(artUrl);
    if (!base) return null;
    const img = raster.dim(raster.cloneImage(base), brightness);
    const uri = raster.encodeJpeg(img, 88);
    this.rendered.set(key, uri);
    return uri;
  }
}

module.exports = { ArtCache, sizedArtworkUrl };
