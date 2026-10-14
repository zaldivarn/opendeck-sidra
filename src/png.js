'use strict';

// Minimal PNG decoder (8-bit greyscale / RGB / palette / grey+alpha / RGBA, non-interlaced).
// Sidra caches artwork under a .jpg name whatever the bytes are, so the odd PNG cover
// can arrive through a file:// URL; this keeps those from falling back to a placeholder.

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf) {
  return buf.length > 8 && buf.subarray(0, 8).equals(SIG);
}

function decodePng(buf) {
  if (!isPng(buf)) throw new Error('not a PNG');
  let off = 8;
  let width, height, bitDepth, colorType, interlace;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace) throw new Error('interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: break;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      let r, g, bl, al = 255;
      switch (colorType) {
        case 0: r = g = bl = line[s]; break;
        case 2: r = line[s]; g = line[s + 1]; bl = line[s + 2]; break;
        case 3: {
          const idx = line[s];
          r = palette[idx * 3]; g = palette[idx * 3 + 1]; bl = palette[idx * 3 + 2];
          if (trns && idx < trns.length) al = trns[idx];
          break;
        }
        case 4: r = g = bl = line[s]; al = line[s + 1]; break;
        case 6: r = line[s]; g = line[s + 1]; bl = line[s + 2]; al = line[s + 3]; break;
      }
      // Composite onto black: keys have no transparency.
      out[o] = (r * al) / 255;
      out[o + 1] = (g * al) / 255;
      out[o + 2] = (bl * al) / 255;
      out[o + 3] = 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

module.exports = { isPng, decodePng };
