'use strict';
//
// internationale.mid, made real.
//
// The tune is synthesized in the browser and played back through an ordinary
// <audio> element. No audio file ships with this page: the samples are
// generated at load, wrapped in a WAV header, and handed to the element as a
// blob, so the whole site is still one document plus its clip art.
//
// The composition (Pierre De Geyter, 1888) is public domain. Nothing here is a
// recording of anyone's performance; every sample is computed on the spot.
//
// Why an <audio> element rather than the Web Audio API, which is the obvious
// tool for synthesizing tones:
//
//   1. iOS silences the Web Audio API when the hardware ring/silent switch is
//      set to silent, and gives no error when it does. An <audio> element is
//      ordinary media playback and stands a much better chance of being heard.
//   2. An <audio> element loops natively, so there is no scheduler to keep
//      running and nothing to drift.
//   3. Its play() returns a promise that actually reports why it was refused,
//      which is the difference between debugging this and guessing at it.
//
// Two constraints shape the rest. Every browser refuses audio that no gesture
// asked for, so the page arms itself and starts on the first tap. And iOS wants
// play() called synchronously inside that gesture, which is why the samples are
// built at load time: by the time a finger lands, there is nothing left to do
// but start.

(function () {
  var NOTE = {
    G3: 196.00, A3: 220.00, B3: 246.94,
    C4: 261.63, D4: 293.66, E4: 329.63, Fs4: 369.99, G4: 392.00, A4: 440.00, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, Fs5: 739.99, G5: 783.99,
    R: 0
  };

  // The tune, as [note, beats]. Reconstructed by ear in G major, so this table
  // is the part most likely to want a correction; any wrong note is one line.
  var MELODY = [
    ['D4', 1],
    ['G4', 1.5], ['G4', 0.5], ['G4', 1], ['B4', 1],
    ['D5', 1.5], ['C5', 0.5], ['B4', 1], ['A4', 1],
    ['B4', 1], ['A4', 1], ['G4', 1], ['Fs4', 1],
    ['G4', 2], ['D4', 1], ['D4', 1],
    ['G4', 1.5], ['A4', 0.5], ['B4', 1], ['C5', 1],
    ['D5', 1.5], ['C5', 0.5], ['B4', 1], ['A4', 1],
    ['B4', 1], ['A4', 1], ['G4', 1], ['A4', 1],
    ['G4', 3], ['D4', 1],
    ['G4', 1], ['G4', 1], ['C5', 1.5], ['C5', 0.5],
    ['C5', 1], ['B4', 1], ['A4', 1], ['G4', 1],
    ['A4', 1], ['B4', 1], ['C5', 1], ['A4', 1],
    ['G4', 2], ['D4', 1], ['D4', 1],
    ['G4', 1], ['A4', 1], ['B4', 1], ['C5', 1],
    ['D5', 2], ['B4', 1], ['G4', 1],
    ['A4', 1], ['B4', 1], ['C5', 1], ['D5', 1],
    ['G4', 3], ['R', 1]
  ];

  var BASS = ['G3', 'G3', 'C4', 'G3', 'D4', 'G3', 'C4', 'D4',
              'G3', 'C4', 'D4', 'G3', 'C4', 'G3', 'D4', 'G3'];

  var BPM = 92;
  var BEAT = 60 / BPM;
  var RATE = 22050;
  // iOS ignores volume set on an audio element, so the level has to be baked
  // into the samples rather than applied at playback.
  var LEVEL = 0.22;

  var audio = null;
  var ready = false;
  var stoppedByUser = false;

  try { stoppedByUser = sessionStorage.getItem('midiOff') === '1'; } catch (e) {}

  function el(id) { return document.getElementById(id); }

  // --- synthesis -----------------------------------------------------------

  var square = function (phase) { return phase < 0.5 ? 1 : -1; };
  var triangle = function (phase) { return 4 * Math.abs(phase - 0.5) - 1; };

  function render() {
    var beats = 0;
    var i;
    for (i = 0; i < MELODY.length; i++) beats += MELODY[i][1];
    var total = Math.ceil(beats * BEAT * RATE) + RATE; // a beat of air at the end
    var buf = new Float32Array(total);

    // Melody, square wave, with a short attack and a decay so it reads as an
    // instrument rather than a beep.
    var at = 0;
    for (i = 0; i < MELODY.length; i++) {
      var freq = NOTE[MELODY[i][0]];
      var len = MELODY[i][1] * BEAT;
      var n = Math.floor(len * RATE);
      if (freq) {
        for (var s = 0; s < n; s++) {
          var t = s / RATE;
          var env = Math.min(1, t / 0.015) * Math.max(0, 1 - t / (len * 0.98));
          var idx = at + s;
          if (idx < total) buf[idx] += square((freq * t) % 1) * env * 0.5;
        }
      }
      at += n;
    }

    // Bass, triangle, two notes to the bar underneath.
    for (i = 0; i < BASS.length; i++) {
      var bf = NOTE[BASS[i]];
      var barAt = Math.floor(i * 4 * BEAT * RATE);
      if (barAt >= total) break;
      for (var half = 0; half < 2; half++) {
        var start = barAt + Math.floor(half * 2 * BEAT * RATE);
        var bn = Math.floor(BEAT * 1.6 * RATE);
        for (var bs = 0; bs < bn; bs++) {
          var bt = bs / RATE;
          var benv = Math.min(1, bt / 0.02) * Math.max(0, 1 - bt / (BEAT * 1.55));
          var bi = start + bs;
          if (bi < total) buf[bi] += triangle((bf * bt) % 1) * benv * (half ? 0.4 : 0.6);
        }
      }
    }

    return buf;
  }

  // 16-bit mono PCM in a WAV wrapper. Written by hand because the alternative
  // is shipping an encoder to produce forty-four known bytes.
  function toWav(samples) {
    var n = samples.length;
    var out = new ArrayBuffer(44 + n * 2);
    var view = new DataView(out);
    var write = function (off, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);        // PCM header size
    view.setUint16(20, 1, true);         // format: PCM
    view.setUint16(22, 1, true);         // channels: mono
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);  // byte rate
    view.setUint16(32, 2, true);         // block align
    view.setUint16(34, 16, true);        // bits per sample
    write(36, 'data');
    view.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var v = Math.max(-1, Math.min(1, samples[i] * LEVEL));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([out], { type: 'audio/wav' });
  }

  // --- the element ---------------------------------------------------------

  function build() {
    if (ready) return;
    try {
      audio = document.createElement('audio');
      audio.loop = true;
      audio.preload = 'auto';
      // Without this iOS takes over the screen with its own player.
      audio.setAttribute('playsinline', '');
      audio.src = URL.createObjectURL(toWav(render()));
      audio.load();
      var box = document.querySelector('.midibox');
      if (box) box.appendChild(audio);
      ready = true;
    } catch (e) {
      say('AUDIO UNAVAILABLE IN THIS BROWSER');
    }
  }

  function say(text) {
    var status = el('midiStatus');
    if (status) status.textContent = text;
  }

  function paint() {
    var btn = el('midiToggle');
    if (!btn) return;
    var on = audio && !audio.paused;
    btn.textContent = on ? '■ STOP' : '▶ PLAY';
    say((on ? 'NOW PLAYING' : 'STOPPED') + ': internationale.mid');
  }

  function start() {
    build();
    if (!audio) return;
    var p = audio.play();
    if (p && p.catch) {
      p.then(function () {
        stoppedByUser = false;
        try { sessionStorage.removeItem('midiOff'); } catch (e) {}
        paint();
      }).catch(function (err) {
        // A refusal is a decision, not a crash, and saying which one it was
        // turns "it does not work" into something fixable.
        var why = err && err.name === 'NotAllowedError'
          ? 'BLOCKED BY BROWSER, PRESS PLAY'
          : 'COULD NOT START: ' + ((err && err.name) || 'UNKNOWN');
        say(why);
      });
    } else {
      paint();
    }
  }

  function stop(byUser) {
    if (audio) { audio.pause(); audio.currentTime = 0; }
    if (byUser) {
      stoppedByUser = true;
      try { sessionStorage.setItem('midiOff', '1'); } catch (e) {}
    }
    paint();
  }

  function init() {
    var btn = el('midiToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        if (audio && !audio.paused) stop(true); else start();
      });
    }

    // Building at load, outside any gesture, is the whole point: iOS wants
    // play() called synchronously when the finger lands, so there must be
    // nothing left to compute by then.
    build();
    paint();

    // Arm. pointerdown and touchend are both here because a tap is the only
    // gesture a phone will honour, and click alone lands too late on some
    // versions of mobile Safari.
    var events = ['pointerdown', 'touchend', 'click', 'keydown'];
    var arm = function (ev) {
      // The button runs its own handler. Without this one tap would start the
      // music here and toggle it straight back off there.
      if (ev && ev.target && ev.target.closest && ev.target.closest('#midiToggle')) return;
      events.forEach(function (e) { document.removeEventListener(e, arm); });
      if (!stoppedByUser && (!audio || audio.paused)) start();
    };
    events.forEach(function (e) { document.addEventListener(e, arm, { passive: true }); });

    if (audio) {
      audio.addEventListener('play', paint);
      audio.addEventListener('pause', paint);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
