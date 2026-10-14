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

module.exports = {
  KEY_SIZE,
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
