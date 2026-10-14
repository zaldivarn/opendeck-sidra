'use strict';

// Tiny RGBA raster helpers: decode album art, resample it to key size, draw
// anti-aliased overlay glyphs, and encode the result. Everything is pure JS so the
// plugin needs nothing beyond Node itself.

const jpeg = require('jpeg-js');

const KEY_SIZE = 144; // OpenDeck renders keys on a 144x144 canvas

function createImage(w, h, rgb = [0, 0, 0]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function cloneImage(img) {
  return { width: img.width, height: img.height, data: Buffer.from(img.data) };
}

function decodeJpeg(buf) {
  return jpeg.decode(buf, { useTArray: false, formatAsRGBA: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 40 });
}

// CRC-32 for PNG chunks.
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * PNG data URI (RGB, Sub filter, fast zlib). Several times quicker than JPEG in pure JS,
 * which matters for visualizer frames drawn many times a second.
 */
function encodePng(img) {
  const { width: w, height: h, data } = img;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 1; // Sub: each byte minus the one to its left
    let pr = 0, pg = 0, pb = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = row + 1 + x * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      raw[o] = (r - pr) & 255;
      raw[o + 1] = (g - pg) & 255;
      raw[o + 2] = (b - pb) & 255;
      pr = r; pg = g; pb = b;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', require('zlib').deflateSync(raw, { level: 2 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function encodeJpeg(img, quality = 90) {
  const out = jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality);
  return `data:image/jpeg;base64,${out.data.toString('base64')}`;
}

/** Centre-crop to square and box-filter down (or bilinear up) to size x size. */
function resizeSquare(src, size = KEY_SIZE) {
  const side = Math.min(src.width, src.height);
  const ox = (src.width - side) / 2;
  const oy = (src.height - side) / 2;
  const dst = createImage(size, size);
  const scale = side / size;
  if (scale >= 1) {
    // Area average: every source pixel overlapping the destination pixel contributes.
    for (let y = 0; y < size; y++) {
      const sy0 = oy + y * scale;
      const sy1 = sy0 + scale;
      for (let x = 0; x < size; x++) {
        const sx0 = ox + x * scale;
        const sx1 = sx0 + scale;
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
          const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
          if (wy <= 0 || sy < 0 || sy >= src.height) continue;
          for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
            const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
            if (wx <= 0 || sx < 0 || sx >= src.width) continue;
            const w = wx * wy;
            const i = (sy * src.width + sx) * 4;
            r += src.data[i] * w;
            g += src.data[i + 1] * w;
            b += src.data[i + 2] * w;
            wsum += w;
          }
        }
        const o = (y * size + x) * 4;
        dst.data[o] = Math.round(r / wsum);
        dst.data[o + 1] = Math.round(g / wsum);
        dst.data[o + 2] = Math.round(b / wsum);
        dst.data[o + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < size; y++) {
      const fy = Math.min(Math.max(oy + (y + 0.5) * scale - 0.5, 0), src.height - 1);
      const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, src.height - 1), ty = fy - y0;
      for (let x = 0; x < size; x++) {
        const fx = Math.min(Math.max(ox + (x + 0.5) * scale - 0.5, 0), src.width - 1);
        const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, src.width - 1), tx = fx - x0;
        const o = (y * size + x) * 4;
        for (let c = 0; c < 3; c++) {
          const a = src.data[(y0 * src.width + x0) * 4 + c];
          const b = src.data[(y0 * src.width + x1) * 4 + c];
          const d = src.data[(y1 * src.width + x0) * 4 + c];
          const e = src.data[(y1 * src.width + x1) * 4 + c];
          dst.data[o + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
        }
        dst.data[o + 3] = 255;
      }
    }
  }
  return dst;
}

/** Multiply brightness (0..1). */
function dim(img, factor) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.round(d[i] * factor);
    d[i + 1] = Math.round(d[i + 1] * factor);
    d[i + 2] = Math.round(d[i + 2] * factor);
  }
  return img;
}

/** Darken towards the bottom so a title drawn there stays legible. */
function bottomShade(img, start = 0.45, strength = 0.75) {
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    if (t < start) continue;
    const f = 1 - strength * ((t - start) / (1 - start));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round(data[i] * f);
      data[i + 1] = Math.round(data[i + 1] * f);
      data[i + 2] = Math.round(data[i + 2] * f);
    }
  }
  return img;
}

/** Darken towards the top edge (for a title drawn at the top). */
function topShade(img, end = 0.55, strength = 0.75) {
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    if (t > end) break;
    const f = 1 - strength * ((end - t) / end);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round(data[i] * f);
      data[i + 1] = Math.round(data[i + 1] * f);
      data[i + 2] = Math.round(data[i + 2] * f);
    }
  }
  return img;
}

/** Darken a horizontal band through the middle (for a centred title). */
function middleShade(img, strength = 0.55) {
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y++) {
    const d = Math.abs(y / (h - 1) - 0.5) / 0.32; // 0 at centre, 1 at the band's edge
    if (d >= 1) continue;
    const f = 1 - strength * (1 - d * d);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round(data[i] * f);
      data[i + 1] = Math.round(data[i + 1] * f);
      data[i + 2] = Math.round(data[i + 2] * f);
    }
  }
  return img;
}

/**
 * Fill a shape given an inside(x, y) test, with 4x4 supersampling for smooth edges.
 * bbox limits the work to [x0, y0, x1, y1].
 */
function fillShape(img, inside, rgb, opacity = 1, bbox = [0, 0, img.width, img.height]) {
  const N = 4;
  const [bx0, by0, bx1, by1] = bbox.map((v, i) => (i < 2 ? Math.max(0, Math.floor(v)) : Math.min(i === 2 ? img.width : img.height, Math.ceil(v))));
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      let hits = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          if (inside(x + (sx + 0.5) / N, y + (sy + 0.5) / N)) hits++;
        }
      }
      if (!hits) continue;
      const a = (hits / (N * N)) * opacity;
      const i = (y * img.width + x) * 4;
      img.data[i] = Math.round(img.data[i] * (1 - a) + rgb[0] * a);
      img.data[i + 1] = Math.round(img.data[i + 1] * (1 - a) + rgb[1] * a);
      img.data[i + 2] = Math.round(img.data[i + 2] * (1 - a) + rgb[2] * a);
    }
  }
}

const shapes = {
  circle(cx, cy, r) {
    const r2 = r * r;
    return { inside: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r2, bbox: [cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1] };
  },
  roundRect(x0, y0, x1, y1, rad) {
    return {
      inside: (x, y) => {
        if (x < x0 || x > x1 || y < y0 || y > y1) return false;
        const dx = Math.max(x0 + rad - x, 0, x - (x1 - rad));
        const dy = Math.max(y0 + rad - y, 0, y - (y1 - rad));
        return dx * dx + dy * dy <= rad * rad;
      },
      bbox: [x0 - 1, y0 - 1, x1 + 1, y1 + 1],
    };
  },
  triangle(ax, ay, bx, by, cx, cy) {
    const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
    return {
      inside: (x, y) => {
        const d1 = sign(x, y, ax, ay, bx, by);
        const d2 = sign(x, y, bx, by, cx, cy);
        const d3 = sign(x, y, cx, cy, ax, ay);
        const neg = d1 < 0 || d2 < 0 || d3 < 0;
        const pos = d1 > 0 || d2 > 0 || d3 > 0;
        return !(neg && pos);
      },
      bbox: [Math.min(ax, bx, cx) - 1, Math.min(ay, by, cy) - 1, Math.max(ax, bx, cx) + 1, Math.max(ay, by, cy) + 1],
    };
  },
};

function draw(img, shape, rgb, opacity) {
  fillShape(img, shape.inside, rgb, opacity, shape.bbox);
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** Play triangle centred on (cx, cy), fitting a circle of radius r, nudged right for optical balance. */
function drawPlayGlyph(img, cx, cy, r) {
  const h = r * 1.15;
  const w = h * 0.9;
  const ox = cx - w / 2 + r * 0.12;
  draw(img, shapes.triangle(ox, cy - h / 2, ox, cy + h / 2, ox + w, cy), WHITE, 1);
}

function drawPauseGlyph(img, cx, cy, r) {
  const h = r * 1.1;
  const bw = r * 0.34;
  const gap = r * 0.3;
  const rad = bw * 0.25;
  draw(img, shapes.roundRect(cx - gap / 2 - bw, cy - h / 2, cx - gap / 2, cy + h / 2, rad), WHITE, 1);
  draw(img, shapes.roundRect(cx + gap / 2, cy - h / 2, cx + gap / 2 + bw, cy + h / 2, rad), WHITE, 1);
}

/** Translucent dark disc with a play or pause glyph inside. */
function drawBadge(img, kind, cx, cy, r, discOpacity = 0.55) {
  draw(img, shapes.circle(cx, cy, r), BLACK, discOpacity);
  if (kind === 'play') drawPlayGlyph(img, cx, cy, r * 0.62);
  else drawPauseGlyph(img, cx, cy, r * 0.62);
}

// ---------------------------------------------------------------- visualizer

/**
 * Audio bars over the cover. levels: 0..1 per bar. style: 'bottom' (rise from the bottom
 * edge) or 'center' (mirrored about the middle). Each bar gets a soft dark outline so it
 * reads on light and busy covers alike.
 */
function drawBars(img, levels, { style = 'bottom', color = [255, 255, 255], opacity = 0.92 } = {}) {
  const S = img.width;
  const n = levels.length;
  const margin = 9;
  const gap = 2.2;
  const barW = (S - margin * 2 - gap * (n - 1)) / n;
  const rad = Math.min(barW / 2, 2.6);
  const minH = 3; // a resting dot so the bars are visible during quiet passages
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, levels[i]));
    const x0 = margin + i * (barW + gap);
    const x1 = x0 + barW;
    let y0, y1;
    if (style === 'center') {
      const half = minH / 2 + v * (S * 0.36);
      y0 = S / 2 - half;
      y1 = S / 2 + half;
    } else {
      const bottom = S - margin;
      y1 = bottom;
      y0 = bottom - (minH + v * (S * 0.58));
    }
    draw(img, shapes.roundRect(x0 - 1.2, y0 - 1.2, x1 + 1.2, y1 + 1.2, rad + 1.2), [0, 0, 0], 0.5);
    draw(img, shapes.roundRect(x0, y0, x1, y1, rad), color, opacity);
  }
  return img;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}

/**
 * A colour from the cover that stands out against it, for bars drawn on top of it:
 *  - if the cover has a second, clearly different colour (say a yellow sun on a purple sky),
 *    use that one, brightened;
 *  - otherwise use a light tint of its main colour, which reads over the darker cover;
 *  - greyscale covers give a soft white.
 */
function accentColour(img) {
  const bins = new Float64Array(36);
  const sat = new Float64Array(36);
  let total = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 16) {
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    total++;
    if (s < 0.25 || l < 0.12 || l > 0.92) continue;
    const b = Math.floor(h * 36) % 36;
    const w = s * (1 - Math.abs(l - 0.5));
    bins[b] += w;
    sat[b] += s * w;
  }
  const around = (b) => bins[b] + 0.5 * (bins[(b + 35) % 36] + bins[(b + 1) % 36]);
  let main = -1, mainW = 0;
  for (let b = 0; b < 36; b++) if (around(b) > mainW) { mainW = around(b); main = b; }
  if (main < 0 || bins[main] < total * 0.02) return [235, 235, 240];
  // A second colour at least 60° round the colour wheel, with a real presence on the cover.
  let second = -1, secondW = 0;
  for (let b = 0; b < 36; b++) {
    const dist = Math.min(Math.abs(b - main), 36 - Math.abs(b - main));
    if (dist >= 6 && around(b) > secondW) { secondW = around(b); second = b; }
  }
  const satOf = (b) => Math.max(0.6, Math.min(0.95, sat[b] / Math.max(1e-9, bins[b])));
  if (second >= 0 && secondW >= mainW * 0.12 && bins[second] >= total * 0.01) {
    return hslToRgb((second + 0.5) / 36, satOf(second), 0.62);
  }
  return hslToRgb((main + 0.5) / 36, satOf(main), 0.84);
}

function parseHex(hex, fallback = [255, 255, 255]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

module.exports = {
  KEY_SIZE,
  encodePng,
  topShade,
  middleShade,
  drawBars,
  accentColour,
  parseHex,
  createImage,
  cloneImage,
  decodeJpeg,
  encodeJpeg,
  resizeSquare,
  dim,
  bottomShade,
  drawBadge,
  drawPlayGlyph,
  drawPauseGlyph,
  draw,
  shapes,
};
