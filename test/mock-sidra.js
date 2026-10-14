'use strict';

// A stand-in for Sidra's MPRIS service, shaped after Sidra's src/integrations/mpris:
// org.mpris.MediaPlayer2.sidra at /org/mpris/MediaPlayer2, trackids /org/sidra/track/<id>.

const dbus = require('dbus-next');

const { Interface, ACCESS_READ, ACCESS_READWRITE } = dbus.interface;
const { Variant } = dbus;

function metadataFor(t) {
  if (!t) return {};
  const md = {
    'mpris:trackid': new Variant('o', `/org/sidra/track/${t.id}`),
    'xesam:title': new Variant('s', t.title),
    'xesam:artist': new Variant('as', [t.artist]),
    'xesam:album': new Variant('s', t.album),
    'mpris:length': new Variant('x', BigInt(t.lengthUs || 200000000)),
  };
  if (t.artUrl) md['mpris:artUrl'] = new Variant('s', t.artUrl);
  if (t.url) md['xesam:url'] = new Variant('s', t.url);
  return md;
}

async function startMockSidra({ tracks, busName = 'org.mpris.MediaPlayer2.sidra' }) {
  const calls = [];
  const bus = dbus.sessionBus();
  let index = 0;
  let status = 'Paused';
  let shuffle = false;

  class Root extends Interface {
    get Identity() {
      return 'Sidra';
    }
    get CanRaise() {
      return true;
    }
    Raise() {
      calls.push('Raise');
    }
    Quit() {}
  }
  Root.configureMembers({
    properties: { Identity: { signature: 's', access: ACCESS_READ }, CanRaise: { signature: 'b', access: ACCESS_READ } },
    methods: { Raise: { inSignature: '', outSignature: '' }, Quit: { inSignature: '', outSignature: '' } },
  });

  class Player extends Interface {
    get PlaybackStatus() {
      return status;
    }
    get Shuffle() {
      return shuffle;
    }
    set Shuffle(v) {
      calls.push(`SetShuffle:${v}`);
      shuffle = Boolean(v);
      setTimeout(() => Interface.emitPropertiesChanged(player, { Shuffle: shuffle }, []), 30);
    }
    get Metadata() {
      return metadataFor(tracks[index]);
    }
    get CanControl() {
      return true;
    }
    get CanGoNext() {
      return true;
    }
    Play() {
      calls.push('Play');
      setStatus('Playing');
    }
    Pause() {
      calls.push('Pause');
      setStatus('Paused');
    }
    PlayPause() {
      calls.push('PlayPause');
      setStatus(status === 'Playing' ? 'Paused' : 'Playing');
    }
    Next() {
      calls.push('Next');
      setTrack((index + 1) % tracks.length);
    }
    Previous() {
      calls.push('Previous');
      setTrack((index - 1 + tracks.length) % tracks.length);
    }
    Seek(offset) {
      calls.push(`Seek:${offset}`);
    }
  }
  Player.configureMembers({
    properties: {
      PlaybackStatus: { signature: 's', access: ACCESS_READ },
      Shuffle: { signature: 'b', access: ACCESS_READWRITE },
      Metadata: { signature: 'a{sv}', access: ACCESS_READ },
      CanControl: { signature: 'b', access: ACCESS_READ },
      CanGoNext: { signature: 'b', access: ACCESS_READ },
    },
    methods: {
      Play: { inSignature: '', outSignature: '' },
      Pause: { inSignature: '', outSignature: '' },
      PlayPause: { inSignature: '', outSignature: '' },
      Next: { inSignature: '', outSignature: '' },
      Previous: { inSignature: '', outSignature: '' },
      Seek: { inSignature: 'x', outSignature: '' },
    },
  });

  const root = new Root('org.mpris.MediaPlayer2');
  const player = new Player('org.mpris.MediaPlayer2.Player');

  function setStatus(s) {
    status = s;
    Interface.emitPropertiesChanged(player, { PlaybackStatus: s }, []);
  }
  function setTrack(i, extra = {}) {
    index = i;
    Interface.emitPropertiesChanged(player, { Metadata: metadataFor(tracks[index]), ...extra }, []);
  }
  /** Mimic Sidra swapping the https cover for its file:// cache copy. */
  function swapArt(url) {
    tracks[index] = { ...tracks[index], artUrl: url };
    Interface.emitPropertiesChanged(player, { Metadata: metadataFor(tracks[index]) }, []);
  }

  bus.export('/org/mpris/MediaPlayer2', root);
  bus.export('/org/mpris/MediaPlayer2', player);
  await bus.requestName(busName, 0);

  return {
    calls,
    get status() {
      return status;
    },
    get shuffle() {
      return shuffle;
    },
    get index() {
      return index;
    },
    setStatus,
    setTrack,
    swapArt,
    async stop() {
      await bus.releaseName(busName);
      bus.disconnect();
    },
  };
}

module.exports = { startMockSidra };
