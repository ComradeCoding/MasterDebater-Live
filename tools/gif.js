'use strict';
//
// Just enough GIF to read and write the clip art this site ships.
//
// The homepage runs on animated GIFs that arrived at full resolution and are
// drawn as 18 to 26 pixel icons. Shrinking a PNG only needs a resampler,
// because zlib is in the standard library. GIF carries its own compressor,
// LZW, and Node ships nothing that speaks it, so both halves are here.
//
// Reading returns composed frames: every frame is a complete w*h*4 RGBA
// buffer, with disposal methods and frame offsets already applied. Callers
// resample plain images and never learn that GIF paints in patches.
//
// Writing takes the same shape back and does the three things that decide how
// big the result is: quantise to a shared palette, cut each frame down to the
// rectangle that actually changed, and blank the pixels inside that rectangle
// which did not. LZW then has long runs of one repeated index to chew on,
// which is the whole reason the format compresses animation at all.
//
// Deliberately not a general GIF library. Local colour tables are read but
// never written, and plain-text extensions are skipped rather than rendered.

const fs = require('fs');

const MAX_CODE = 4096;

// ---------------------------------------------------------------- reading

// Sub-blocks are GIF's framing: a length byte, that many bytes, repeat, until
// a length of zero. Data can and does span them, so they are joined before
// anything tries to read a code out of them.
function readSubBlocks(buf, p) {
  const parts = [];
  for (;;) {
    const n = buf[p++];
    if (!n) break;
    parts.push(buf.slice(p, p + n));
    p += n;
  }
  return { data: Buffer.concat(parts), end: p };
}

function skipSubBlocks(buf, p) {
  for (;;) {
    const n = buf[p++];
    if (!n) return p;
    p += n;
  }
}

function lzwDecode(data, minCodeSize, pixelCount) {
  const out = Buffer.alloc(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  // A dictionary entry is a prefix code plus one byte. Storing it that way
  // rather than as a growing string keeps the table flat and the walk cheap.
  const prefix = new Int32Array(MAX_CODE);
  const suffix = new Uint8Array(MAX_CODE);
  const stack = new Uint8Array(MAX_CODE + 1);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; }

  let codeSize = minCodeSize + 1;
  let next = clear + 2;
  let prev = -1;
  let o = 0;

  // Codes are packed low bit first and straddle byte boundaries, so bytes are
  // shifted into a running accumulator and codes taken off the bottom. Reading
  // bit by bit instead costs a loop per bit, which on the sickle is seventy
  // two frames of thirty five thousand pixels.
  let acc = 0;
  let accBits = 0;
  let p = 0;

  while (o < pixelCount) {
    while (accBits < codeSize && p < data.length) {
      acc |= data[p++] << accBits;
      accBits += 8;
    }
    if (accBits < codeSize) break;
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    accBits -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = clear + 2;
      prev = -1;
      continue;
    }
    if (code === eoi) break;

    if (prev < 0) {
      out[o++] = suffix[code];
      prev = code;
      continue;
    }

    let sp = 0;
    let walk = code;

    // The self-referential case: a code for an entry that is only about to be
    // built. It can only ever mean the previous entry with its own first byte
    // appended, which is knowable without the entry existing.
    if (code >= next) {
      stack[sp++] = firstByte(prefix, clear, prev);
      walk = prev;
    }

    while (walk >= clear) { stack[sp++] = suffix[walk]; walk = prefix[walk]; }
    const first = walk & 0xff;
    stack[sp++] = first;

    if (next < MAX_CODE) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    }

    prev = code;
    while (sp > 0 && o < pixelCount) out[o++] = stack[--sp];
  }
  return out;
}

function firstByte(prefix, clear, code) {
  while (code >= clear) code = prefix[code];
  return code & 0xff;
}

// Interlaced GIFs store rows in four passes so a slow modem showed a coarse
// picture early. Nothing downstream wants to know that, so it is undone here.
function deinterlace(src, w, h) {
  const dst = Buffer.alloc(w * h);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let row = 0;
  for (const pass of passes) {
    for (let y = pass[0]; y < h; y += pass[1]) {
      src.copy(dst, y * w, row * w, row * w + w);
      row++;
    }
  }
  return dst;
}

function read(file) {
  const buf = fs.readFileSync(file);
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') {
    throw new Error(file + ': not a GIF, header reads ' + JSON.stringify(sig));
  }

  let p = 6;
  const W = buf.readUInt16LE(p); p += 2;
  const H = buf.readUInt16LE(p); p += 2;
  const packed = buf[p++];
  p += 2;                                    // background index, pixel aspect

  let gct = null;
  if (packed & 0x80) {
    const n = 1 << ((packed & 7) + 1);
    gct = buf.slice(p, p + n * 3);
    p += n * 3;
  }

  const frames = [];
  let loop = 0;
  let gce = null;

  // The composed picture so far. Zeroed, so anything a frame never paints
  // stays transparent rather than turning up black.
  let canvas = Buffer.alloc(W * H * 4);
  let saved = null;

  while (p < buf.length) {
    const kind = buf[p++];
    if (kind === 0x3b) break;                // trailer

    if (kind === 0x21) {                     // extension
      const label = buf[p++];
      if (label === 0xf9) {
        const size = buf[p++];
        const flags = buf[p];
        gce = {
          disposal: (flags >> 2) & 7,
          transparent: (flags & 1) === 1,
          delay: buf.readUInt16LE(p + 1),
          transIndex: buf[p + 3],
        };
        p = skipSubBlocks(buf, p + size);
      } else if (label === 0xff) {
        const size = buf[p];
        const name = buf.toString('ascii', p + 1, p + 1 + size);
        p += 1 + size;
        const sub = readSubBlocks(buf, p);
        p = sub.end;
        if (name === 'NETSCAPE2.0' && sub.data.length >= 3 && sub.data[0] === 1) {
          loop = sub.data.readUInt16LE(1);
        }
      } else {
        p = skipSubBlocks(buf, p);
      }
      continue;
    }

    if (kind !== 0x2c) {
      throw new Error(file + ': unknown block 0x' + kind.toString(16) + ' at ' + (p - 1));
    }

    const left = buf.readUInt16LE(p); p += 2;
    const top = buf.readUInt16LE(p); p += 2;
    const iw = buf.readUInt16LE(p); p += 2;
    const ih = buf.readUInt16LE(p); p += 2;
    const ip = buf[p++];

    let ct = gct;
    if (ip & 0x80) {
      const n = 1 << ((ip & 7) + 1);
      ct = buf.slice(p, p + n * 3);
      p += n * 3;
    }
    if (!ct) throw new Error(file + ': frame has neither a local nor a global palette');

    const minCodeSize = buf[p++];
    const sub = readSubBlocks(buf, p);
    p = sub.end;

    let idx = lzwDecode(sub.data, minCodeSize, iw * ih);
    if (ip & 0x40) idx = deinterlace(idx, iw, ih);

    const g = gce || { disposal: 0, transparent: false, delay: 0, transIndex: -1 };
    if (g.disposal === 3) saved = Buffer.from(canvas);

    for (let y = 0; y < ih; y++) {
      const cy = top + y;
      if (cy < 0 || cy >= H) continue;
      for (let x = 0; x < iw; x++) {
        const cx = left + x;
        if (cx < 0 || cx >= W) continue;
        const i = idx[y * iw + x];
        if (g.transparent && i === g.transIndex) continue;
        const s = i * 3;
        const d = (cy * W + cx) * 4;
        canvas[d] = ct[s];
        canvas[d + 1] = ct[s + 1];
        canvas[d + 2] = ct[s + 2];
        canvas[d + 3] = 255;
      }
    }

    frames.push({ rgba: Buffer.from(canvas), delay: g.delay, disposal: g.disposal });

    if (g.disposal === 2) {
      for (let y = top; y < Math.min(H, top + ih); y++) {
        canvas.fill(0, (y * W + left) * 4, (y * W + Math.min(W, left + iw)) * 4);
      }
    } else if (g.disposal === 3 && saved) {
      canvas = saved;
      saved = null;
    }
    gce = null;
  }

  if (!frames.length) throw new Error(file + ': no image frames');
  return { w: W, h: H, loop, frames };
}

// ---------------------------------------------------------------- palette

// Median cut. Repeatedly take the box holding the widest spread of colour and
// split it at the median of its longest axis. Splitting by population rather
// than by the midpoint of the range is what stops a handful of stray pixels
// claiming a palette entry each while a face shares one.
function quantise(counts, max) {
  const entries = [];
  for (const pair of counts) {
    entries.push({
      r: (pair[0] >> 16) & 0xff, g: (pair[0] >> 8) & 0xff, b: pair[0] & 0xff, count: pair[1],
    });
  }
  if (entries.length <= max) {
    return entries.map(function (e) { return [e.r, e.g, e.b]; });
  }

  const boxes = [entries];
  while (boxes.length < max) {
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const s = spread(boxes[i]);
      if (s.range > best) { best = s.range; pick = i; }
    }
    if (pick < 0) break;                     // every box is a single colour

    const box = boxes[pick];
    const axis = spread(box).axis;
    box.sort(function (a, b) { return a[axis] - b[axis]; });

    // Cut where half the pixels lie, not half the entries.
    let total = 0;
    for (const e of box) total += e.count;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].count;
      cut = i + 1;
      if (acc * 2 >= total) break;
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }

  return boxes.map(function (box) {
    let r = 0, g = 0, b = 0, n = 0;
    for (const e of box) { r += e.r * e.count; g += e.g * e.count; b += e.b * e.count; n += e.count; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

function spread(box) {
  let rlo = 255, rhi = 0, glo = 255, ghi = 0, blo = 255, bhi = 0;
  for (const e of box) {
    if (e.r < rlo) rlo = e.r;
    if (e.r > rhi) rhi = e.r;
    if (e.g < glo) glo = e.g;
    if (e.g > ghi) ghi = e.g;
    if (e.b < blo) blo = e.b;
    if (e.b > bhi) bhi = e.b;
  }
  // Weighted toward green, which the eye resolves far better than blue, so a
  // box wide in green is worth splitting before one equally wide in blue.
  const dr = (rhi - rlo) * 0.30, dg = (ghi - glo) * 0.59, db = (bhi - blo) * 0.11;
  if (dg >= dr && dg >= db) return { axis: 'g', range: dg };
  if (dr >= db) return { axis: 'r', range: dr };
  return { axis: 'b', range: db };
}

function nearest(pal, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b;
    const d = dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- writing

function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  let codeSize = minCodeSize + 1;
  let next = clear + 2;
  // Keyed by prefix * 256 + byte. A plain object would work and would also
  // rehash a hundred thousand string keys per frame.
  let table = new Map();

  let out = Buffer.alloc(1024);
  let len = 0;
  let acc = 0;
  let accBits = 0;

  function push(byte) {
    if (len === out.length) {
      const bigger = Buffer.alloc(out.length * 2);
      out.copy(bigger);
      out = bigger;
    }
    out[len++] = byte;
  }

  function emit(code) {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
  }

  if (!indices.length) {
    emit(clear);
    emit(eoi);
    if (accBits > 0) push(acc & 0xff);
    return out.slice(0, len);
  }

  emit(clear);
  let prev = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prev * 256 + k;
    const found = table.get(key);
    if (found !== undefined) {
      prev = found;
      continue;
    }
    emit(prev);
    if (next < MAX_CODE) {
      table.set(key, next);
      next++;
      // One later than the decoder's own rule, and deliberately. The decoder
      // only starts adding entries on the second code it reads, so it is
      // permanently one behind. Widening in step with our own table instead
      // of with its table desynchronises the two on the very first jump.
      if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
    } else {
      // The table is full. Start over rather than keep emitting codes built
      // from a dictionary that no longer matches what is coming.
      emit(clear);
      table = new Map();
      codeSize = minCodeSize + 1;
      next = clear + 2;
    }
    prev = k;
  }

  emit(prev);
  emit(eoi);
  if (accBits > 0) push(acc & 0xff);

  return out.slice(0, len);
}

function subBlocks(data) {
  const parts = [];
  for (let p = 0; p < data.length; p += 255) {
    const chunk = data.slice(p, p + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// The rectangle in which two frames differ. Everything outside it is already
// on screen from the frame before, so it never needs to be sent again.
function changedBox(a, b, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;                   // frames are identical
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// The rectangle holding everything this frame actually paints. In the mode
// where each frame stands alone, that rectangle is all a viewer has to be
// handed, because the frame before it cleared itself away first.
function opaqueBox(rgba, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;                   // frame paints nothing at all
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// GIF transparency is one bit. Anything part-way has to commit, so the caller
// picks the line, and a matte decides whether the pixels above it keep their
// blend against a background colour or go fully opaque with a hard edge.
function flatten(rgba, cutoff, matte) {
  const out = Buffer.from(rgba);
  for (let o = 0; o < out.length; o += 4) {
    const a = out[o + 3];
    if (a < cutoff) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      continue;
    }
    if (matte && a < 255) {
      const f = a / 255;
      out[o] = Math.round(out[o] * f + matte[0] * (1 - f));
      out[o + 1] = Math.round(out[o + 1] * f + matte[1] * (1 - f));
      out[o + 2] = Math.round(out[o + 2] * f + matte[2] * (1 - f));
    }
    out[o + 3] = 255;
  }
  return out;
}

// The rectangle holding every pixel that this frame lights and the next one
// needs dark. Painting cannot turn a pixel transparent, so these are exactly
// the pixels that have to be wiped between the two, and nothing else does.
function darkenedBox(cur, next, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (next[o + 3] !== 0 || cur[o + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x: x, y: y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function withRectCleared(rgba, w, box) {
  const out = Buffer.from(rgba);
  for (let y = box.y; y < box.y + box.h; y++) {
    out.fill(0, (y * w + box.x) * 4, (y * w + box.x + box.w) * 4);
  }
  return out;
}

// Lay the animation out: one rectangle per frame, and what becomes of it.
//
// A frame stays on screen unless the frame after it needs one of its pixels
// dark. Painting only ever adds, so the only way to take a pixel back is to
// have the frame under it wipe itself, and a wipe is a rectangle. That
// rectangle has to reach the pixels going dark, and it has to reach whatever
// this frame is changing, and it needs to reach nothing else. Sizing it to
// cover everything the frame painted is what turns a moving cursor over a
// still background into a full canvas repaint sixty eight times over.
//
// Wiping takes out correct pixels along with the stale ones, so the next
// frame is compared against what the wipe left behind rather than against
// this frame. That is the whole reason the pass carries a canvas at all.
function layout(w, h, frames) {
  const n = frames.length;
  const plan = [];
  let base = null;                           // what is on screen, null means blank

  for (let i = 0; i < n; i++) {
    const cur = frames[i].rgba;
    let box = base ? changedBox(base, cur, w, h) : opaqueBox(cur, w, h);
    const gone = i + 1 < n ? darkenedBox(cur, frames[i + 1].rgba, w, h) : null;
    if (gone) box = union(box, gone);
    // A frame identical to what is already showing still has to occupy its
    // slice of time, so it becomes a one pixel patch repainting what is there.
    if (!box) box = { x: 0, y: 0, w: 1, h: 1 };

    plan.push({ box: box, clear: !!gone, base: base, delay: frames[i].delay });
    base = gone ? withRectCleared(cur, w, box) : cur;
  }
  return plan;
}

function write(file, w, h, framesIn, opts) {
  const o = opts || {};
  const cutoff = o.alphaCutoff === undefined ? 128 : o.alphaCutoff;
  const loop = o.loop === undefined ? 0 : o.loop;

  const frames = framesIn.map(function (f) {
    return {
      rgba: flatten(f.rgba, cutoff, o.matte),
      delay: f.delay === undefined ? 10 : f.delay,
    };
  });

  let anyTransparent = false;
  for (const f of frames) {
    for (let i = 3; i < f.rgba.length; i += 4) {
      if (f.rgba[i] === 0) { anyTransparent = true; break; }
    }
    if (anyTransparent) break;
  }

  // Patches need an index meaning "whatever is already here", whether the art
  // has any transparency of its own or not.
  const needsTransparent = anyTransparent || frames.length > 1;

  const counts = new Map();
  for (const f of frames) {
    for (let i = 0; i < f.rgba.length; i += 4) {
      if (f.rgba[i + 3] === 0) continue;
      const key = (f.rgba[i] << 16) | (f.rgba[i + 1] << 8) | f.rgba[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const room = needsTransparent ? 255 : 256;
  const pal = quantise(counts, Math.min(room, o.colors || room));

  // Nearest entry rather than whichever box the colour fell into. Median cut
  // averages a box down to one colour, and that average is not always the
  // closest thing in the finished palette to every colour it swallowed.
  const lookup = new Map();
  for (const key of counts.keys()) {
    lookup.set(key, nearest(pal, (key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff));
  }

  const used = pal.length + (needsTransparent ? 1 : 0);
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, used))));
  const paletteSize = 1 << bits;
  const transIndex = needsTransparent ? pal.length : 0;
  const minCodeSize = Math.max(2, bits);

  const table = Buffer.alloc(paletteSize * 3);
  pal.forEach(function (c, i) {
    table[i * 3] = c[0]; table[i * 3 + 1] = c[1]; table[i * 3 + 2] = c[2];
  });

  const plan = layout(w, h, frames);

  // Masking is a gamble either way, so it is run both ways and the smaller
  // file wins. Sending unchanged pixels as transparent is usually a large
  // win, because a rectangle that is mostly one repeated index is what LZW is
  // for. On dithered photographic frames the changed pixels are scattered
  // noise, and punching holes through them makes the index stream less
  // repetitive than simply sending the pixels.
  function build(mask) {
    const parts = [];

    const head = Buffer.alloc(13);
    head.write('GIF89a', 0, 'ascii');
    head.writeUInt16LE(w, 6);
    head.writeUInt16LE(h, 8);
    head[10] = 0x80 | (7 << 4) | (bits - 1);
    head[11] = 0;
    head[12] = 0;
    parts.push(head, table);

    if (frames.length > 1) {
      const app = Buffer.alloc(19);
      app[0] = 0x21; app[1] = 0xff; app[2] = 11;
      app.write('NETSCAPE2.0', 3, 'ascii');
      app[14] = 3; app[15] = 1;
      app.writeUInt16LE(loop, 16);
      app[18] = 0;
      parts.push(app);
    }

    let area = 0;
    let cleared = 0;

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const box = step.box;
      const cur = frames[i].rgba;
      const base = step.base;
      area += box.w * box.h;
      if (step.clear) cleared++;

      const idx = Buffer.alloc(box.w * box.h);
      for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
          const s = ((box.y + y) * w + (box.x + x)) * 4;
          let val;
          if (cur[s + 3] === 0) {
            val = transIndex;
          } else if (mask && base
              && base[s + 3] !== 0
              && base[s] === cur[s] && base[s + 1] === cur[s + 1] && base[s + 2] === cur[s + 2]) {
            val = transIndex;                // unchanged, let what is there show
          } else {
            val = lookup.get((cur[s] << 16) | (cur[s + 1] << 8) | cur[s + 2]);
          }
          idx[y * box.w + x] = val;
        }
      }

      const gce = Buffer.alloc(8);
      gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 4;
      gce[3] = ((step.clear ? 2 : 1) << 2) | (needsTransparent ? 1 : 0);
      gce.writeUInt16LE(step.delay, 4);
      gce[6] = transIndex;
      gce[7] = 0;

      const desc = Buffer.alloc(10);
      desc[0] = 0x2c;
      desc.writeUInt16LE(box.x, 1);
      desc.writeUInt16LE(box.y, 3);
      desc.writeUInt16LE(box.w, 5);
      desc.writeUInt16LE(box.h, 7);
      desc[9] = 0;                           // global palette, not interlaced

      parts.push(gce, desc, Buffer.from([minCodeSize]), subBlocks(lzwEncode(idx, minCodeSize)));
    }

    parts.push(Buffer.from([0x3b]));
    return {
      buffer: Buffer.concat(parts),
      coverage: area / (w * h * frames.length),
      cleared: cleared,
    };
  }

  const masked = build(true);
  const plainer = build(false);
  const best = plainer.buffer.length < masked.buffer.length ? plainer : masked;
  const out = best.buffer;

  if (file) fs.writeFileSync(file, out);
  return {
    bytes: out.length, buffer: out, colors: pal.length,
    transparent: needsTransparent,
    masked: best === masked,
    // How much of the full w*h*frames rectangle actually had to be sent, and
    // how many frames had to wipe themselves rather than stay put.
    coverage: best.coverage,
    cleared: best.cleared,
    frames: frames.length,
  };
}

module.exports = {
  read: read, write: write,
  lzwDecode: lzwDecode, lzwEncode: lzwEncode,
  quantise: quantise, flatten: flatten, changedBox: changedBox,
};
