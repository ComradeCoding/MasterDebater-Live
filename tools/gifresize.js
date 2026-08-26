'use strict';
//
// Downscale an animated GIF to the size it is actually drawn at.
//
//   node tools/gifresize.js <in.gif> <out.gif> <max-dimension> [options]
//
//     --cutoff N   alpha at or above N survives, below it goes clear (default 128)
//     --colors N   palette ceiling (default 255, the most GIF leaves once one
//                  index is spent on transparency)
//     --matte RRGGBB  blend part-covered pixels toward this colour instead of
//                  letting them snap to fully opaque
//     --size WxH   exact output size, instead of fitting a maximum dimension
//
// Prefer an exact size that is a whole multiple of the size the icon is drawn
// at. A browser shrinking by exactly two averages four pixels into one; at one
// and a half it lands between pixels the whole way across, and the result is
// visibly worse than shipping fewer pixels on a clean ratio.
//
// The sickle arrived 179 by 200 and is drawn at eighteen pixels. The book
// arrived 500 by 449 and is drawn at twenty two. Between them the icons on the
// homepage carry about a third of a megabyte to fill an area smaller than a
// postage stamp.
//
// Aim for twice the size the icon is drawn at, not the size itself. GIF gives
// one bit of transparency, so a downscaled edge has to pick a side and the
// result is a staircase. Handing the browser twice the pixels lets its own
// downscale average that staircase back into something smooth, which is the
// nearest thing to an alpha channel the format allows.

const path = require('path');
const fs = require('fs');
const gif = require('./gif');
const { resize } = require('./resize');

function run(inFile, outFile, max, opts) {
  const src = gif.read(inFile);
  let dw, dh;
  if (opts.size) {
    dw = opts.size[0];
    dh = opts.size[1];
  } else {
    const scale = max / Math.max(src.w, src.h);
    dw = Math.max(1, Math.round(src.w * scale));
    dh = Math.max(1, Math.round(src.h * scale));
  }

  const frames = src.frames.map(function (f) {
    return { rgba: resize(f.rgba, src.w, src.h, dw, dh), delay: f.delay };
  });

  const res = gif.write(outFile, dw, dh, frames, {
    loop: src.loop,
    alphaCutoff: opts.cutoff,
    colors: opts.colors,
    matte: opts.matte,
  });

  const before = fs.statSync(inFile).size;
  return {
    from: src.w + 'x' + src.h,
    to: dw + 'x' + dh,
    frames: src.frames.length,
    colors: res.colors,
    masked: res.masked,
    wipes: res.cleared + '/' + res.frames,
    coverage: (res.coverage * 100).toFixed(1) + '%',
    bytesIn: before,
    bytesOut: res.bytes,
    saved: (100 - (res.bytes / before) * 100).toFixed(1) + '%',
  };
}

module.exports = { run: run };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { cutoff: 128, colors: 255, matte: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cutoff') opts.cutoff = Number(args[++i]);
    else if (args[i] === '--colors') opts.colors = Number(args[++i]);
    else if (args[i] === '--matte') {
      const hex = args[++i].replace(/^#/, '');
      opts.matte = [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    } else if (args[i] === '--size') {
      opts.size = args[++i].split('x').map(Number);
    } else rest.push(args[i]);
  }
  const [inFile, outFile, maxArg] = rest;
  if (!inFile || !outFile || (!maxArg && !opts.size)) {
    console.error('usage: node ' + path.basename(__filename)
      + ' <in.gif> <out.gif> <max-dimension> [--size WxH] [--cutoff N]'
      + ' [--colors N] [--matte RRGGBB]');
    process.exit(1);
  }
  console.log(JSON.stringify(run(inFile, outFile, Number(maxArg), opts), null, 2));
}
