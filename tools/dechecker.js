'use strict';
//
// Knock a baked-in transparency checkerboard out of a PNG.
//
// Stock "transparent PNG" sites often serve the preview with the checker
// pattern drawn into the pixels, so the file has an alpha channel and every
// pixel in it is opaque. This finds the checker and makes it actually
// transparent.
//
//   node dechecker.js <in.png> <out.png>
//
// It floods inward from the border rather than replacing every matching pixel
// in the image. A global replace would punch holes anywhere the subject
// happens to contain the same near-white, which on a photograph is common.
// Only checker reachable from the edge is background by definition.
//
// Handles 8-bit RGBA, non-interlaced PNGs whose scanlines are unfiltered,
// which is what these files are. Anything else it refuses rather than
// silently mangling.

const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function read(file) {
  const b = fs.readFileSync(file);
  let p = 8;
  const idat = [];
  let ihdr = null;
  let ihdrData = null;
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    const data = b.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdrData = data;
      ihdr = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8 || ihdr.color !== 6 || ihdr.interlace !== 0) {
    throw new Error(`need 8-bit RGBA non-interlaced, got depth ${ihdr.depth} colour ${ihdr.color} interlace ${ihdr.interlace}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = 1 + ihdr.w * 4;
  for (let y = 0; y < ihdr.h; y++) {
    if (raw[y * stride] !== 0) throw new Error(`scanline ${y} is filtered (type ${raw[y * stride]})`);
  }
  return { ihdr, ihdrData, raw, stride };
}

function run(inFile, outFile) {
  const { ihdr, ihdrData, raw, stride } = read(inFile);
  const { w, h } = ihdr;

  // The two greys the checker is drawn in, sampled from the corners rather
  // than assumed, so a different site's palette still works.
  const at = (x, y) => y * stride + 1 + x * 4;
  const corner = (x, y) => [raw[at(x, y)], raw[at(x, y) + 1], raw[at(x, y) + 2]];
  const seen = new Map();
  for (let y = 0; y < Math.min(60, h); y++) {
    for (let x = 0; x < Math.min(60, w); x++) {
      const k = corner(x, y).join(',');
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
    Math.abs(raw[o] - r) <= TOL && Math.abs(raw[o + 1] - g) <= TOL && Math.abs(raw[o + 2] - b) <= TOL);

  // Flood inward from every border pixel. 4-connected, iterative, because a
  // recursive fill on a million pixels blows the stack.
  const done = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (x, y) => {
    const i = y * w + x;
    if (done[i]) return;
    if (!isChecker(at(x, y))) return;
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
    raw[at(i % w, (i / w) | 0) + 3] = 0;
    cleared++;
  }

  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdrData),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(outFile, out);

  return {
    size: `${w}x${h}`,
    palette: palette.map((c) => 'rgb(' + c.join(',') + ')'),
    cleared,
    percent: ((cleared / (w * h)) * 100).toFixed(1) + '%',
    bytesIn: fs.statSync(inFile).size,
    bytesOut: out.length,
  };
}

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error('usage: dechecker.js <in.png> <out.png>'); process.exit(1); }
console.log(JSON.stringify(run(inFile, outFile), null, 2));
