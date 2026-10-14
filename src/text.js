'use strict';

// Fitting song text onto a key. OpenDeck draws key titles itself (centred, one line per
// "\n"), so all we control is how many characters each line carries.

const GAP = '     ';

function chars(s) {
  return Array.from(String(s || ''));
}

function truncate(text, width) {
  const c = chars(text);
  if (c.length <= width) return String(text || '');
  return c.slice(0, Math.max(1, width - 1)).join('').trimEnd() + '…';
}

/** Greedy word-wrap into at most maxLines lines; the last line is ellipsised if needed. */
function wrap(text, width, maxLines) {
  const tokens = [];
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    let c = chars(word);
    while (c.length > width) {
      tokens.push(c.slice(0, width).join(''));
      c = c.slice(width);
    }
    if (c.length) tokens.push(c.join(''));
  }
  const lines = [];
  let cur = '';
  for (const t of tokens) {
    const candidate = cur ? `${cur} ${t}` : t;
    if (chars(candidate).length <= width) cur = candidate;
    else {
      if (cur) lines.push(cur);
      cur = t;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncate(lines.slice(maxLines - 1).join(' '), width);
  return kept;
}

/** A `width`-character window into `text`, scrolling one step per tick with a pause at the start. */
function marquee(text, width, tick, pauseTicks = 5) {
  const c = chars(text);
  if (c.length <= width) return String(text || '');
  const loop = c.concat(chars(GAP));
  const period = loop.length + pauseTicks;
  const t = ((tick % period) + period) % period;
  const offset = Math.max(0, t - pauseTicks);
  let out = '';
  for (let i = 0; i < width; i++) out += loop[(offset + i) % loop.length];
  return out;
}

function overflows(text, width) {
  return chars(text).length > width;
}

module.exports = { truncate, wrap, marquee, overflows };
