'use strict';
//
// internationale.mid, made real.
//
// The marquee has been promising this since 1997, so here it is: the tune
// synthesized on the fly with two oscillators, a square wave carrying the
// melody and a triangle underneath it. No audio file ships with this page,
// which keeps the site the single hand-typed document it claims to be and
// means the thing loads in bytes rather than megabytes.
//
// The composition (Pierre De Geyter, 1888) is public domain. Nothing here is
// a recording of anyone's performance; every note is generated in the browser.
//
// Two things worth knowing about autoplay. Every modern browser refuses to
// start audio without a user gesture, so a page cannot simply blare on load
// the way a Geocities page did. What it can do is arm itself and start on the
// visitor's first click anywhere, which is what happens below. And a visitor
// who presses STOP is remembered for the session, because overriding somebody
// who has explicitly silenced you is how you get a tab closed.

(function () {
  var NOTE = {
    G3: 196.00, A3: 220.00, B3: 246.94,
    C4: 261.63, D4: 293.66, E4: 329.63, Fs4: 369.99, G4: 392.00, A4: 440.00, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, Fs5: 739.99, G5: 783.99,
    R: 0
  };

  // The tune, as [note, beats]. Reconstructed by ear in G major, so treat this
  // table as the one part of the page most likely to want a correction: it is
  // plain data and any wrong note is a one line fix.
  var MELODY = [
    // Verse
    ['D4', 1],
    ['G4', 1.5], ['G4', 0.5], ['G4', 1], ['B4', 1],
    ['D5', 1.5], ['C5', 0.5], ['B4', 1], ['A4', 1],
    ['B4', 1], ['A4', 1], ['G4', 1], ['Fs4', 1],
    ['G4', 2], ['D4', 1], ['D4', 1],
    ['G4', 1.5], ['A4', 0.5], ['B4', 1], ['C5', 1],
    ['D5', 1.5], ['C5', 0.5], ['B4', 1], ['A4', 1],
    ['B4', 1], ['A4', 1], ['G4', 1], ['A4', 1],
    ['G4', 3], ['D4', 1],
    // Chorus
    ['G4', 1], ['G4', 1], ['C5', 1.5], ['C5', 0.5],
    ['C5', 1], ['B4', 1], ['A4', 1], ['G4', 1],
    ['A4', 1], ['B4', 1], ['C5', 1], ['A4', 1],
    ['G4', 2], ['D4', 1], ['D4', 1],
    ['G4', 1], ['A4', 1], ['B4', 1], ['C5', 1],
    ['D5', 2], ['B4', 1], ['G4', 1],
    ['A4', 1], ['B4', 1], ['C5', 1], ['D5', 1],
    ['G4', 3], ['R', 1]
  ];

  // One root per bar of four beats, walked underneath the melody.
  var BASS = ['G3', 'G3', 'C4', 'G3', 'D4', 'G3', 'C4', 'D4',
              'G3', 'C4', 'D4', 'G3', 'C4', 'G3', 'D4', 'G3'];

  var BPM = 92;
  var BEAT = 60 / BPM;

  var ctx = null;
  var master = null;
  var timer = null;
  var playing = false;
  var stoppedByUser = false;

  try {
    stoppedByUser = sessionStorage.getItem('midiOff') === '1';
  } catch (e) { /* storage blocked, treat as not stopped */ }

  function el(id) { return document.getElementById(id); }

  function ensureContext() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    // Deliberately modest. Nobody asked to be startled.
    master.gain.value = 0.16;
    master.connect(ctx.destination);
    return ctx;
  }

  // One note, with a short attack and a long-ish decay so the square wave reads
  // as an instrument rather than a beep.
  function tone(freq, start, dur, type, level) {
    if (!freq) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + 0.02);
    gain.gain.setValueAtTime(level, start + dur * 0.7);
    gain.gain.linearRampToValueAtTime(0, start + dur * 0.98);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + dur);
  }

  // Schedules the whole tune ahead of time and re-arms itself at the end, so
  // playback does not depend on a timer firing punctually mid-phrase.
  function schedule() {
    var t = ctx.currentTime + 0.08;
    var beats = 0;
    var i;

    for (i = 0; i < MELODY.length; i++) {
      var name = MELODY[i][0];
      var len = MELODY[i][1] * BEAT;
      tone(NOTE[name], t + beats * BEAT, len, 'square', 0.5);
      beats += MELODY[i][1];
    }

    for (i = 0; i < BASS.length; i++) {
      var at = t + i * 4 * BEAT;
      if (i * 4 >= beats) break;
      tone(NOTE[BASS[i]], at, BEAT * 1.6, 'triangle', 0.75);
      tone(NOTE[BASS[i]], at + 2 * BEAT, BEAT * 1.6, 'triangle', 0.55);
    }

    var total = beats * BEAT;
    timer = setTimeout(function () { if (playing) schedule(); }, (total + 0.6) * 1000);
  }

  function play() {
    if (playing) return;
    if (!ensureContext()) return;
    // Created suspended when there has been no gesture yet; resume returns a
    // promise that rejects on browsers that refuse, which is not an error.
    var resumed = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    resumed.then(function () {
      if (playing) return;
      playing = true;
      stoppedByUser = false;
      try { sessionStorage.removeItem('midiOff'); } catch (e) {}
      render();
      schedule();
    }).catch(function () { /* blocked, the button is still there */ });
  }

  function stop(byUser) {
    playing = false;
    clearTimeout(timer);
    timer = null;
    if (ctx) {
      // Closing kills every scheduled note at once, which is what STOP should
      // do. A fresh context is built on the next play.
      try { ctx.close(); } catch (e) {}
      ctx = null;
      master = null;
    }
    if (byUser) {
      stoppedByUser = true;
      try { sessionStorage.setItem('midiOff', '1'); } catch (e) {}
    }
    render();
  }

  function render() {
    var status = el('midiStatus');
    var btn = el('midiToggle');
    if (!status || !btn) return;
    status.textContent = playing
      ? 'NOW PLAYING: internationale.mid'
      : 'STOPPED: internationale.mid';
    btn.textContent = playing ? '■ STOP' : '▶ PLAY';
  }

  function init() {
    var btn = el('midiToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        if (playing) stop(true); else play();
      });
    }
    render();

    // Arm it. The first click anywhere starts the music the way the page would
    // have in 1999, unless the visitor has already told us to be quiet.
    var arm = function () {
      document.removeEventListener('click', arm);
      document.removeEventListener('keydown', arm);
      if (!stoppedByUser && !playing) play();
    };
    document.addEventListener('click', arm);
    document.addEventListener('keydown', arm);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
