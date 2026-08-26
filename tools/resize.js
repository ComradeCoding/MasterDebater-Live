'use strict';
//
// Downscale a PNG to the size it is actually drawn at.
//
//   node tools/resize.js <in.png> <out.png> <max-dimension>
//
// Several of the images on the homepage arrived at full resolution and are
// rendered as 22px icons. A 1280px ring costs a megabyte to draw at the size
// of a full stop.
//
// Box filter: every destination pixel averages the whole source region it
// covers, rather than sampling one pixel out of the middle of it. At these
// ratios, roughly twenty to one, point sampling throws away 399 pixels out of
// every 400 and the result looks like it was cut with scissors.
//
// The averaging is done on premultiplied alpha. Averaging colour and alpha
// separately pulls the colour of fully transparent pixels into the edge, which
// on a cut-out means a halo of whatever used to be behind the subject.

const path = require('path');
const png = require('./png');

function resize(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((dx + 1) * xRatio)));

      let r = 0, g = 0, b = 0, aSum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * sw + x) * 4;
          const a = src[o + 3] / 255;
          r += src[o] * a;
          g += src[o + 1] * a;
          b += src[o + 2] * a;
          aSum += a;
          n++;
        }
      }

      const o = (dy * dw + dx) * 4;
      // aSum is the total coverage in the box, which is exactly the weight the
      // premultiplied sums were accumulated against.
      if (aSum > 0) {
        dst[o] = Math.min(255, Math.round(r / aSum));
        dst[o + 1] = Math.min(255, Math.round(g / aSum));
        dst[o + 2] = Math.min(255, Math.round(b / aSum));
      }
      dst[o + 3] = Math.min(255, Math.round((aSum / n) * 255));
    }
  }
  return dst;
}

function run(inFile, outFile, max) {
  const { w, h, rgba } = png.read(inFile);
  if (Math.max(w, h) <= max) {
    return { skipped: true, reason: `already ${w}x${h}, within ${max}` };
  }
  const scale = max / Math.max(w, h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const out = resize(rgba, w, h, dw, dh);
  const bytes = png.write(outFile, dw, dh, out);
  return {
    from: `${w}x${h}`,
    to: `${dw}x${dh}`,
    bytesIn: require('fs').statSync(inFile).size,
    bytesOut: bytes,
    saved: `${(100 - (bytes / require('fs').statSync(inFile).size) * 100).toFixed(1)}%`,
  };
}

// The filter itself is worth sharing with the GIF resizer, which runs it over
// every frame. Only the command line half is skipped when this is required.
module.exports = { resize: resize, run: run };

if (require.main === module) {
  const [, , inFile, outFile, maxArg] = process.argv;
  if (!inFile || !outFile || !maxArg) {
    console.error('usage: node ' + path.basename(__filename) + ' <in.png> <out.png> <max-dimension>');
    process.exit(1);
  }
  console.log(JSON.stringify(run(inFile, outFile, Number(maxArg)), null, 2));
}
