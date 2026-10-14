'use strict';

// Drive the property inspector page in jsdom with a fake WebSocket, the way OpenDeck would.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = require('assert/strict');

const html = fs.readFileSync(require('path').join(__dirname, '../plugin-static/pi/index.html'), 'utf8');

function open(action, settings) {
  const sent = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      FakeWS.last = this;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    send(s) {
      sent.push(JSON.parse(s));
    }
  }
  w.WebSocket = FakeWS;
  w.connectElgatoStreamDeckSocket(57116, 'dev.Default.Keypad.3.0', 'registerPropertyInspector', '{}',
    JSON.stringify({ action, context: 'dev.Default.Keypad.3.0', payload: { settings } }));
  return { w, sent, ws: () => FakeWS.last };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

console.log('settings page');
(async () => {
  // Song Display: correct section, defaults filled, change saves the whole section.
  {
    const { w, sent } = open('com.zaldivarn.sidra.nowplaying', { fields: 'title' });
    await tick();
    const d = w.document;
    assert.equal(d.getElementById('sec-nowplaying').hidden, false);
    assert.equal(d.getElementById('sec-playpauseart').hidden, true);
    assert.equal(d.getElementById('sec-library').hidden, true);
    assert.equal(d.getElementById('fields').value, 'title');
    assert.equal(d.getElementById('lineChars').value, '12');
    assert.equal(d.getElementById('scroll').checked, true);
    assert.deepEqual(sent.slice(0, 2).map((m) => m.event), ['registerPropertyInspector', 'sendToPlugin']);
    const sel = d.getElementById('press');
    sel.value = 'playpause';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    const save = sent.find((m) => m.event === 'setSettings');
    assert.deepEqual(save.payload, { fields: 'title', background: 'art', scroll: true, speed: 'normal', lineChars: 12, press: 'playpause' });
    console.log('  ✓ Song Display settings page');
  }
  // Album-art Play/Pause.
  {
    const { w, sent, ws } = open('com.zaldivarn.sidra.playpauseart', {});
    await tick();
    const d = w.document;
    assert.equal(d.getElementById('sec-playpauseart').hidden, false);
    const cb = d.getElementById('dimWhenPaused');
    assert.equal(cb.checked, true);
    cb.checked = false;
    cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.deepEqual(sent.find((m) => m.event === 'setSettings').payload, { indicator: 'auto', dimWhenPaused: false, launchWhenClosed: true, launchCommand: '', holdAction: 'next', holdTime: 'normal', doubleTapAction: 'none', doubleTapTime: 'normal' });
    // "Opens Sidra" toggle: on by default; turning it off greys out the command and saves.
    const toggle = d.getElementById('launchWhenClosed');
    assert.equal(toggle.checked, true);
    assert.equal(d.getElementById('launchCommand').disabled, false);
    toggle.checked = false;
    toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(d.getElementById('launchCommand').disabled, true);
    assert.equal(sent.filter((m) => m.event === 'setSettings').pop().payload.launchWhenClosed, false);
    ws().onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: { type: 'status', sidra: 'not running', launch: { ok: true, message: 'Opens with desktop entry ~/.local/share/applications/sidra.desktop' } } }) });
    assert.match(d.getElementById('launchTarget').textContent, /sidra\.desktop/);
    // Gestures: hold → Next by default, double-tap off (its timing greyed out).
    const holdSel = d.getElementById('holdAction'), dblSel = d.getElementById('doubleTapAction');
    assert.equal(holdSel.value, 'next');
    assert.equal(dblSel.value, 'none');
    assert.equal(d.getElementById('doubleTapTime').disabled, true);
    assert.deepEqual([...dblSel.options].map((o) => o.value), ['none', 'next', 'previous', 'replay']);
    dblSel.value = 'replay';
    dblSel.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(d.getElementById('doubleTapTime').disabled, false);
    assert.match(d.getElementById('gestureHint').textContent, /once the double-tap wait has passed/);
    holdSel.value = 'none';
    holdSel.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(d.getElementById('holdTime').disabled, true);
    const saved = sent.filter((m) => m.event === 'setSettings').pop().payload;
    assert.equal(saved.holdAction, 'none');
    assert.equal(saved.doubleTapAction, 'replay');
    assert.equal(d.getElementById('sidraText').textContent, 'Sidra is not running');
    console.log('  ✓ Play/Pause (Album Art) settings page');
  }
  {
    const { w } = open('com.zaldivarn.sidra.playpauseart', { indicator: 'center', dimWhenPaused: true });
    await tick();
    assert.equal(w.document.getElementById('indicator').value, 'auto');
    assert.deepEqual([...w.document.querySelectorAll('#indicator option')].map((o) => o.value), ['auto', 'badge', 'none']);
    console.log("  ✓ retired 'center' setting shows as the large pause icon");
  }
  {
    // v1.3 kept hold-to-skip as an on/off switch; "off" must show as Hold: Off and be dropped on save.
    const { w, sent } = open('com.zaldivarn.sidra.playpauseart', { holdToSkip: false, holdTime: 'long' });
    await tick();
    const d = w.document;
    assert.equal(d.getElementById('holdAction').value, 'none');
    assert.equal(d.getElementById('holdTime').value, 'long');
    d.getElementById('doubleTapAction').value = 'next';
    d.getElementById('doubleTapAction').dispatchEvent(new w.Event('change', { bubbles: true }));
    const saved = sent.filter((m) => m.event === 'setSettings').pop().payload;
    assert.equal(saved.holdAction, 'none');
    assert.equal('holdToSkip' in saved, false);
    console.log('  ✓ v1.3 hold-to-skip setting carries over');
  }
  // Add to Library: status from plugin, port save.
  {
    const { w, sent, ws } = open('com.zaldivarn.sidra.library', {});
    await tick();
    const d = w.document;
    ws().onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: { type: 'status', sidra: 'connected', playback: 'Playing', track: 'Song — Artist', cdpPort: 9333, cdp: { ok: false, message: 'Nothing is listening on 127.0.0.1:9333.' } } }) });
    assert.match(d.getElementById('sidraText').textContent, /Sidra connected · Playing/);
    assert.equal(d.getElementById('trackText').textContent, 'Song — Artist');
    assert.equal(d.getElementById('cdpPort').value, '9333');
    assert.match(d.getElementById('launchCmd').textContent, /--remote-debugging-port=9333/);
    assert.equal(d.getElementById('cdpDot').className, 'dot bad');
    d.getElementById('cdpPort').value = '9444';
    d.getElementById('savePort').click();
    const msg = sent.filter((m) => m.event === 'sendToPlugin').pop();
    assert.deepEqual(msg.payload, { type: 'setCdpPort', cdpPort: 9444 });
    assert.equal(msg.action, 'com.zaldivarn.sidra.library');
    console.log('  ✓ Add to Library settings page');
  }
  // Simple actions show only the status box.
  {
    const { w } = open('com.zaldivarn.sidra.next', {});
    await tick();
    assert.equal([...w.document.querySelectorAll('section')].every((s) => s.hidden), true);
    console.log('  ✓ simple actions show just the status box');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
