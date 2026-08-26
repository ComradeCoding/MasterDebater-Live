'use strict';
//
// Ziggy, adrift.
//
// The screensaver everyone sat watching in the hope it would strike a corner
// exactly. He drifts across the window and turns at the edges; Marx stays
// pinned, because two of them ricocheting around is a fairground, not a page.
//
// Three details separate this from a naive version:
//
//   1. Movement is in pixels per second against a real clock, not pixels per
//      frame. A per-frame constant runs at whatever rate the display happens
//      to refresh, so the same code ambles on a 60Hz laptop and sprints on a
//      144Hz monitor.
//   2. The frame delta is capped. requestAnimationFrame stops in a background
//      tab, so on return the gap since the last frame can be minutes, and an
//      uncapped step would fling him far outside the window in one go.
//   3. He moves by transform rather than by setting top and left, which would
//      put the browser through layout on every frame.
//
// `step` is kept pure and exported so the edge handling can be tested against
// a simulated clock. Everything the animation gets wrong is in that function,
// and none of it is observable by looking at a running page.

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__bounce = api;
  if (typeof document !== 'undefined') api.attach();
})(typeof self !== 'undefined' ? self : this, function () {

  var SPEED = 46;   // pixels per second, roughly a screensaver's amble
  var MARGIN = 4;   // never quite touching the glass
  var MAX_DT = 0.05;

  // One frame of motion. Given a position, a velocity and how much time has
  // passed, return where it ends up and which way it is now going.
  function step(s, dt, box) {
    dt = Math.min(MAX_DT, dt);
    var x = s.x + s.vx * dt;
    var y = s.y + s.vy * dt;
    var vx = s.vx;
    var vy = s.vy;

    var right = box.W - box.w - MARGIN;
    var bottom = box.H - box.h - MARGIN;

    // When the window is smaller than he is there is no room to travel, so he
    // parks rather than flipping direction on every frame and vibrating.
    if (right <= MARGIN) {
      x = MARGIN;
    } else if (x <= MARGIN) {
      x = MARGIN; vx = Math.abs(vx);
    } else if (x >= right) {
      x = right; vx = -Math.abs(vx);
    }

    if (bottom <= MARGIN) {
      y = MARGIN;
    } else if (y <= MARGIN) {
      y = MARGIN; vy = Math.abs(vy);
    } else if (y >= bottom) {
      y = bottom; vy = -Math.abs(vy);
    }

    return { x: x, y: y, vx: vx, vy: vy };
  }

  function attach() {
    var el = document.querySelector('.bowie');
    if (!el) return;

    var state = null;
    var box = { W: 0, H: 0, w: 0, h: 0 };
    var last = 0;
    var running = false;

    var reduce = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

    function measure() {
      var r = el.getBoundingClientRect();
      // Read here rather than every frame: getBoundingClientRect forces the
      // browser to settle layout, the one thing this loop must not do sixty
      // times a second.
      box.w = r.width;
      box.h = r.height;
      box.W = window.innerWidth;
      box.H = window.innerHeight;
    }

    function place() {
      el.style.transform =
        'translate3d(' + Math.round(state.x) + 'px,' + Math.round(state.y) + 'px,0)';
    }

    function frame(now) {
      if (!running) return;
      if (!last) last = now;
      var dt = (now - last) / 1000;
      last = now;
      state = step(state, dt, box);
      place();
      requestAnimationFrame(frame);
    }

    function start() {
      measure();
      if (!box.w || !box.h) return; // not laid out yet

      // Out of the corner the stylesheet pinned him to. Inline wins, so the
      // media queries keep control of his size and lose control of his
      // position, which is exactly the split we want.
      el.style.top = '0';
      el.style.left = '0';
      el.style.right = 'auto';
      el.style.willChange = 'transform';

      state = {
        x: box.W - box.w - MARGIN,
        y: 36,
        vx: -SPEED * 0.72,
        vy: SPEED * 0.69, // not exactly 45 degrees, or he retraces one line forever
      };
      state = step(state, 0, box);
      place();

      running = true;
      last = 0;
      requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      el.style.transform = '';
      el.style.top = '';
      el.style.left = '';
      el.style.right = '';
      el.style.willChange = '';
    }

    function resize() {
      if (!running) return;
      measure();
      state = step(state, 0, box); // pull him back inside the new window
      place();
    }

    function respectMotion() {
      if (reduce && reduce.matches) {
        if (running) stop();
      } else if (!running) {
        start();
      }
    }

    window.addEventListener('resize', resize);
    if (reduce) {
      // Someone turning motion off mid-visit should see him settle, rather
      // than carry on because the preference was read once at load.
      if (reduce.addEventListener) reduce.addEventListener('change', respectMotion);
      else if (reduce.addListener) reduce.addListener(respectMotion);
    }

    // His size comes from the image, so there is nothing to measure until it
    // has decoded.
    if (el.complete && el.naturalWidth) respectMotion();
    else el.addEventListener('load', respectMotion, { once: true });
  }

  return { step: step, attach: attach, SPEED: SPEED, MARGIN: MARGIN, MAX_DT: MAX_DT };
});
