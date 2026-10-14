'use strict';

// SVG artwork for keys. Shared by the build script (static manifest images) and the
// plugin at runtime (placeholder keys when there is no album art to show).

const ACCENT = '#fa2d55';
const ACCENT_DARK = '#b3123a';
const FG = '#f5f5f7';
const FG_DIM = '#7c7c82';

function keyBg(id = 'bg') {
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232327"/><stop offset="1" stop-color="#101012"/></linearGradient></defs><rect width="144" height="144" fill="url(#${id})"/>`;
}

function svg144(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${body}</svg>`;
}

// ----- Glyphs (drawn on a 144 grid, centred on 72,72) -----

const glyph = {
  play: (c = FG) =>
    `<path d="M54 42 L54 102 L104 72 Z" fill="${c}" stroke="${c}" stroke-width="8" stroke-linejoin="round"/>`,
  pause: (c = FG) =>
    `<rect x="46" y="42" width="18" height="60" rx="5" fill="${c}"/><rect x="80" y="42" width="18" height="60" rx="5" fill="${c}"/>`,
  next: (c = FG) =>
    `<g fill="${c}" stroke="${c}" stroke-width="6" stroke-linejoin="round"><path d="M34 50 L34 94 L70 72 Z"/><path d="M72 50 L72 94 L108 72 Z"/></g>`,
  previous: (c = FG) =>
    `<g fill="${c}" stroke="${c}" stroke-width="6" stroke-linejoin="round"><path d="M110 50 L110 94 L74 72 Z"/><path d="M72 50 L72 94 L36 72 Z"/></g>`,
  shuffle: (c = FG) =>
    `<g fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M32 50 H48 C70 50 74 94 96 94 H108"/>` +
    `<path d="M32 94 H48 C58 94 64 86 68 78"/><path d="M76 66 C80 58 86 50 96 50 H108"/>` +
    `<path d="M98 40 L110 50 L98 60"/><path d="M98 84 L110 94 L98 104"/></g>`,
  note: (c = FG) =>
    `<g fill="${c}"><path d="M60 40 L108 29 L108 43 L60 54 Z"/><rect x="60" y="42" width="8" height="58"/><rect x="100" y="31" width="8" height="58"/>` +
    `<ellipse cx="52" cy="100" rx="14" ry="11" transform="rotate(-20 52 100)"/><ellipse cx="92" cy="89" rx="14" ry="11" transform="rotate(-20 92 89)"/></g>`,
  libraryAdd: (c = FG) =>
    `<g fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round"><circle cx="72" cy="72" r="38"/><path d="M72 52 V92 M52 72 H92"/></g>`,
  libraryDone: () =>
    `<circle cx="72" cy="72" r="42" fill="${ACCENT}"/><path d="M52 73 L66 87 L94 57" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`,
  songLines: (c = FG) =>
    `<g fill="${c}"><rect x="30" y="40" width="84" height="10" rx="5"/><rect x="30" y="62" width="60" height="10" rx="5" opacity="0.7"/><rect x="30" y="84" width="72" height="10" rx="5" opacity="0.45"/></g>`,
};

// ----- Full key images -----

const keys = {
  play: () => svg144(keyBg() + glyph.play()),
  pause: () => svg144(keyBg() + glyph.pause()),
  next: () => svg144(keyBg() + glyph.next()),
  previous: () => svg144(keyBg() + glyph.previous()),
  shuffleOff: () => svg144(keyBg() + glyph.shuffle(FG_DIM)),
  shuffleOn: () =>
    svg144(keyBg() + `<g transform="translate(0 -6)">${glyph.shuffle(ACCENT)}</g><circle cx="72" cy="118" r="5" fill="${ACCENT}"/>`),
  libraryAdd: () => svg144(keyBg() + glyph.libraryAdd()),
  libraryDone: () => svg144(keyBg() + glyph.libraryDone()),
  songDisplay: () => svg144(keyBg() + glyph.songLines()),
  artPlayPause: () =>
    svg144(
      keyBg() +
        `<rect x="24" y="24" width="96" height="96" rx="14" fill="url(#art)"/>` +
        `<defs><linearGradient id="art" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="${ACCENT_DARK}"/></linearGradient></defs>` +
        `<g transform="translate(72 72) scale(0.62) translate(-72 -72)">${glyph.note('#ffffff')}</g>`,
    ),
};

/** Placeholder for art-driven keys when Sidra is closed, nothing is queued, or the cover won't load. */
function placeholderKey({ caption = '', paused = false } = {}) {
  let body = keyBg();
  const noteY = caption ? -10 : 0;
  body += `<g transform="translate(72 ${72 + noteY}) scale(0.72) translate(-72 -72)" opacity="0.55">${glyph.note(FG_DIM)}</g>`;
  if (paused) {
    body += `<circle cx="108" cy="${caption ? 92 : 108}" r="22" fill="#000" opacity="0.6"/>`;
    body += `<g transform="translate(108 ${caption ? 92 : 108}) scale(0.3) translate(-72 -72)">${glyph.pause()}</g>`;
  }
  if (caption) {
    body += `<text x="72" y="130" text-anchor="middle" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-size="17" font-weight="bold" fill="${FG_DIM}">${escapeXml(caption)}</text>`;
  }
  return svg144(body);
}

function plainBackground() {
  return svg144(keyBg());
}

/** Small monochrome icons for the action list (white on transparent, 20x20 nominal). */
function listIcon(glyphName) {
  const g = glyph[glyphName]();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="24 24 96 96">${g.replace(/#f5f5f7/g, '#ffffff')}</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

module.exports = { keys, glyph, placeholderKey, plainBackground, listIcon, svgDataUri, ACCENT };
