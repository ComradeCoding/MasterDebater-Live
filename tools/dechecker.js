'use strict';
//
// Knock a baked-in transparency checkerboard out of a PNG.
//
//   node tools/dechecker.js <in.png> <out.png>
//
// Stock "transparent PNG" sites often serve the preview with the checker
// pattern drawn into the pixels, so the file has an alpha channel and every
// pixel in it is opaque. This finds the checker and makes it actually
// transparent.
//
// It floods inward from the border rather than replacing every matching pixel
// in the image. A global replace would punch holes anywhere the subject
// happens to contain the same near-white, which on a photograph is common.
// Only checker reachable from the edge is background by definition.

const path = require('path');
const fs = require('fs');
const png = require('./png');

function run(inFile, outFile) {
  const { w, h, rgba } = png.read(inFile);
  const at = (x, y) => (y * w + x) * 4;

  // The two greys the checker is drawn in, sampled from a corner rather than
  // assumed, so a different site's palette still works.
  const seen = new Map();
  for (let y = 0; y < Math.min(60, h); y++) {
    for (let x = 0; x < Math.min(60, w); x++) {
      const o = at(x, y);
      const k = `${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  const palette = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([k]) => k.split(',').map(Number));
  if (palette.length < 2) throw new Error('could not find two checker colours');

  // Tolerance covers the anti-aliased pixels where the subject meets the
  // checker; without it every cut-out edge keeps a pale fringe.
  const TOL = 18;
  const isChecker = (o) => palette.some(([r, g, b]) =>
    Math.abs(rgba[o] - r) <= TOL && Math.abs(rgba[o + 1] - g) <= TOL && Math.abs(rgba[o + 2] - b) <= TOL);

  // Flood inward from every border pixel. Iterative, because a recursive fill
  // over a million pixels blows the stack.
  const done = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (x, y) => {
    const i = y * w + x;
    if (done[i] || !isChecker(at(x, y))) return;
    done[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  let cleared = 0;
  for (let i = 0; i < w * h; i++) {
    if (!done[i]) continue;
    rgba[i * 4 + 3] = 0;
    cleared++;
  }

  const bytes = png.write(outFile, w, h, rgba);
  return {
    size: `${w}x${h}`,
    palette: palette.map((c) => `rgb(${c.join(',')})`),
    cleared,
    percent: `${((cleared / (w * h)) * 100).toFixed(1)}%`,
    bytesIn: fs.statSync(inFile).size,
    bytesOut: bytes,
  };
}

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('usage: node ' + path.basename(__filename) + ' <in.png> <out.png>');
  process.exit(1);
}
console.log(JSON.stringify(run(inFile, outFile), null, 2));
