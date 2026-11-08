'use strict';
//
// The share card: a settled debate drawn as a 1200x630 PNG for link previews.
//
// The permalink is the only page anyone outside a room ever sees, and most of
// them see it first as a preview in somebody else's feed. That preview is an
// image, and the platforms that draw it accept PNG and JPEG, not SVG. So the
// card is real pixels, drawn here with no canvas and no font engine.
//
// Text is a 5x7 bitmap font, stretched taller than it is wide so it reads as
// the same condensed industrial capitals the page sets in Bahnschrift. A
// photocopied flyer is exactly where blocky type belongs, so the constraint
// and the look agree. Everything is uppercase, as it is on the page.
//
// Same content as the head of the permalink, in the same order of loudness:
// the swing figure, large and tilted, then the motion, both names, and the
// opening and closing bars on one scale.

const { encode } = require('./tools/png');

const W = 1200;
const H = 630;

// The flyer palette, as RGB triples. Same values as the stylesheet.
const C = {
  ink: [0x0a, 0x0b, 0x10],
  ink2: [0x10, 0x12, 0x19],
  plate: [0x16, 0x19, 0x23],
  ruleHot: [0x3a, 0x3f, 0x52],
  paper: [0xf4, 0xf1, 0xe9],
  muted: [0x9a, 0xa0, 0xb0],
  dim: [0x5f, 0x65, 0x77],
  pro: [0x3d, 0x7d, 0xff],
  con: [0xff, 0x2d, 0x3f],
  neon: [0xb9, 0x6b, 0xff],
  neonDeep: [0x8b, 0x2f, 0xe6],
};

// --------------------------------------------------------------------------
// The font. Each glyph is seven rows of five; '#' is ink.
// --------------------------------------------------------------------------

const GLYPHS = {
  A: '.###. #...# #...# ##### #...# #...# #...#',
  B: '####. #...# #...# ####. #...# #...# ####.',
  C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '####. #...# #...# #...# #...# #...# ####.',
  E: '##### #.... #.... ####. #.... #.... #####',
  F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .###.',
  H: '#...# #...# #...# ##### #...# #...# #...#',
  I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
  K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  N: '#...# #...# ##..# #.#.# #..## #...# #...#',
  O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....',
  Q: '.###. #...# #...# #...# #.#.# #..#. .##.#',
  R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.',
  T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..',
  W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.',
  X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  Z: '##### ....# ...#. ..#.. .#... #.... #####',
  0: '.###. #...# #..## #.#.# ##..# #...# .###.',
  1: '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  2: '.###. #...# ....# ...#. ..#.. .#... #####',
  3: '####. ....# ....# .###. ....# ....# ####.',
  4: '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  5: '##### #.... ####. ....# ....# #...# .###.',
  6: '..##. .#... #.... ####. #...# #...# .###.',
  7: '##### ....# ...#. ..#.. .#... .#... .#...',
  8: '.###. #...# #...# .###. #...# #...# .###.',
  9: '.###. #...# #...# .#### ....# ...#. .##..',
  ' ': '..... ..... ..... ..... ..... ..... .....',
  '.': '..... ..... ..... ..... ..... .##.. .##..',
  ',': '..... ..... ..... ..... .##.. ..#.. .#...',
  '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..',
  '?': '.###. #...# ....# ...#. ..#.. ..... ..#..',
  "'": '..#.. ..#.. .#... ..... ..... ..... .....',
  '"': '.#.#. .#.#. ..... ..... ..... ..... .....',
  '-': '..... ..... ..... .###. ..... ..... .....',
  '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  ':': '..... .##.. .##.. ..... .##.. .##.. .....',
  ';': '..... .##.. .##.. ..... .##.. ..#.. .#...',
  '/': '....# ....# ...#. ..#.. .#... #.... #....',
  '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.',
  ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...',
  '&': '.##.. #..#. #.#.. .#... #.#.# #..#. .##.#',
  '%': '##... ##..# ...#. ..#.. .#... #..## ...##',
  '#': '.#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.',
  '*': '..... ..#.. #.#.# .###. #.#.# ..#.. .....',
  '=': '..... ..... ##### ..... ##### ..... .....',
  '<': '...#. ..#.. .#... #.... .#... ..#.. ...#.',
  '>': '.#... ..#.. ...#. ....# ...#. ..#.. .#...',
  '_': '..... ..... ..... ..... ..... ..... #####',
  '$': '..#.. .#### #.#.. .###. ..#.# ####. ..#..',
  '@': '.###. #...# #.### #.#.# #.### #.... .###.',
  '·': '..... ..... ..... .##.. .##.. ..... .....',
};
// Parsed once into rows of booleans.
const FONT = {};
for (const [ch, rows] of Object.entries(GLYPHS)) {
  FONT[ch] = rows.split(' ').map((r) => [...r].map((c) => c === '#'));
}

// Anything the font does not have is folded to something it does, so a name
// with an accent or a curly quote still reads rather than turning to noise.
const FOLD = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '`': "'", '^': "'",
  '–': '-', '—': '-', '~': '-', '[': '(', ']': ')', '{': '(', '}': ')',
  '\\': '/', '|': '/', '…': '...',
};
function foldText(s) {
  const out = [];
  for (const raw of String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')) {
    const up = raw.toUpperCase();
    if (FONT[up]) out.push(up);
    else if (FOLD[raw]) out.push(FOLD[raw]);
    else if (/\s/.test(raw)) out.push(' ');
    else out.push('?');
  }
  return out.join('');
}

// A glyph is five columns plus one of space, `sx` pixels each, seven rows of
// `sy`. Making `sy` larger than `sx` is what condenses the face.
const advance = (sx) => 6 * sx;
const textWidth = (text, sx) => (text.length ? text.length * advance(sx) - sx : 0);

// --------------------------------------------------------------------------
// The canvas: an RGBA buffer and the few primitives the card needs.
// --------------------------------------------------------------------------

function canvas(w, h) {
  const px = Buffer.alloc(w * h * 4);
  const set = (x, y, rgb, a = 1) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    if (a >= 1) {
      px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
    } else {
      px[o] = Math.round(px[o] + (rgb[0] - px[o]) * a);
      px[o + 1] = Math.round(px[o + 1] + (rgb[1] - px[o + 1]) * a);
      px[o + 2] = Math.round(px[o + 2] + (rgb[2] - px[o + 2]) * a);
    }
    px[o + 3] = 255;
  };
  const rect = (x, y, rw, rh, rgb) => {
    x = Math.round(x); y = Math.round(y); rw = Math.round(rw); rh = Math.round(rh);
    for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++) {
      for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) set(i, j, rgb);
    }
  };
  const frame = (x, y, rw, rh, t, rgb) => {
    rect(x, y, rw, t, rgb); rect(x, y + rh - t, rw, t, rgb);
    rect(x, y, t, rh, rgb); rect(x + rw - t, y, t, rh, rgb);
  };
  const text = (str, x, y, sx, sy, rgb) => {
    let cx = Math.round(x);
    for (const ch of str) {
      const g = FONT[ch] || FONT['?'];
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) if (g[r][c]) rect(cx + c * sx, y + r * sy, sx, sy, rgb);
      }
      cx += advance(sx);
    }
  };
  return { w, h, px, set, rect, frame, text };
}

// Text drawn into a one-channel mask, so it can be placed at an angle.
function textMask(str, sx, sy) {
  const mw = Math.max(1, textWidth(str, sx));
  const mh = 7 * sy;
  const m = new Uint8Array(mw * mh);
  let cx = 0;
  for (const ch of str) {
    const g = FONT[ch] || FONT['?'];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (!g[r][c]) continue;
        for (let j = 0; j < sy; j++) {
          for (let i = 0; i < sx; i++) m[(r * sy + j) * mw + cx + c * sx + i] = 1;
        }
      }
    }
    cx += advance(sx);
  }
  return { m, mw, mh };
}

// The page's one rotation, -1.5 degrees. Each output pixel is sampled at
// sixteen points mapped back into the unrotated mask, so the tilted edges are
// smooth rather than stair-stepped. `left, top` place the mask's corner
// relative to the pivot before turning.
function stampRotated(cv, mask, pivotX, pivotY, left, top, deg, rgb) {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const { m, mw, mh } = mask;
  const reach = Math.ceil(Math.hypot(Math.abs(left) + mw, Math.abs(top) + mh)) + 2;
  const x0 = Math.max(0, Math.floor(pivotX - reach));
  const x1 = Math.min(cv.w, Math.ceil(pivotX + reach));
  const y0 = Math.max(0, Math.floor(pivotY - reach));
  const y1 = Math.min(cv.h, Math.ceil(pivotY + reach));
  const N = 4;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let hit = 0;
      for (let sj = 0; sj < N; sj++) {
        for (let si = 0; si < N; si++) {
          const dx = x + (si + 0.5) / N - pivotX;
          const dy = y + (sj + 0.5) / N - pivotY;
          // Inverse rotation back into mask space.
          const u = Math.floor(dx * cos + dy * sin - left);
          const v = Math.floor(-dx * sin + dy * cos - top);
          if (u >= 0 && v >= 0 && u < mw && v < mh && m[v * mw + u]) hit++;
        }
      }
      if (hit) cv.set(x, y, rgb, hit / (N * N));
    }
  }
}

// Greedy word wrap on folded text. A word longer than a line is cut, since a
// 140-character motion with no spaces is legal and must still fit.
function wrap(text, perLine) {
  const lines = [];
  let line = '';
  for (let word of text.split(' ').filter(Boolean)) {
    while (word.length > perLine) {
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, perLine));
      word = word.slice(perLine);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= perLine) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// Largest type that fits the box. If even the smallest overflows, the last
// line ends in an ellipsis rather than running off the card.
function fitMotion(text, boxW, boxH) {
  const sizes = [[7, 11], [6, 10], [5, 8], [4, 7], [4, 6]];
  for (const [sx, sy] of sizes) {
    const perLine = Math.floor((boxW + sx) / advance(sx));
    const lead = 7 * sy + Math.round(sy * 1.4);
    const lines = wrap(text, perLine);
    if (lines.length * lead - (lead - 7 * sy) <= boxH) return { sx, sy, lead, lines };
  }
  const [sx, sy] = sizes[sizes.length - 1];
  const perLine = Math.floor((boxW + sx) / advance(sx));
  const lead = 7 * sy + Math.round(sy * 1.4);
  const fit = Math.max(1, Math.floor((boxH + lead - 7 * sy) / lead));
  const lines = wrap(text, perLine).slice(0, fit);
  const last = lines[fit - 1] || '';
  lines[fit - 1] = (last.length + 3 > perLine ? last.slice(0, perLine - 3) : last) + '...';
  return { sx, sy, lead, lines };
}

// A deterministic stand-in for random, seeded from the debate id, so the same
// record always produces byte-identical speckle and therefore the same file.
function seeded(id) {
  let s = parseInt(id, 16) || 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

// --------------------------------------------------------------------------

function render(record) {
  const v = record.verdict;
  const cv = canvas(W, H);
  const M = 56;

  // Toner speckle: sparse and faint, like the fixed layer under the page.
  cv.rect(0, 0, W, H, C.ink);
  const rnd = seeded(record.id);
  for (let i = 0; i < 2600; i++) {
    cv.set(Math.floor(rnd() * W), Math.floor(rnd() * H), C.muted, 0.12 + rnd() * 0.1);
  }

  // Masthead, the same wordmark as the live header: half of it a cut block.
  cv.rect(0, 0, W, 92, C.ink2);
  cv.rect(0, 92, W, 4, C.paper);
  cv.text('MASTERDEBATER', M, 30, 4, 5, C.paper);
  const liveX = M + textWidth('MASTERDEBATER', 4) + 14;
  cv.rect(liveX, 22, textWidth('LIVE', 4) + 20, 51, C.neonDeep);
  cv.text('LIVE', liveX + 10, 30, 4, 5, [255, 255, 255]);
  cv.text('SETTLED', W - M - textWidth('SETTLED', 3), 36, 3, 4, C.dim);

  // The motion. Largest size that fits three or four lines.
  const motion = fitMotion(foldText(record.topic), W - 2 * M, 244);
  motion.lines.forEach((line, i) => {
    cv.text(line, M, 128 + i * motion.lead, motion.sx, motion.sy, C.paper);
  });

  // ---- the verdict block, along the bottom -------------------------------
  const top = 396;
  const bottom = H - 40;

  // The swing, in a box with the page's one hard shadow, scaled to the card.
  const boxW = 300;
  const boxH = bottom - top;
  cv.rect(M + 8, top + 8, boxW, boxH, C.neon);
  cv.rect(M, top, boxW, boxH, C.ink2);
  cv.frame(M, top, boxW, boxH, 3, C.paper);

  const winColor = v.winner === 'pro' ? C.pro : v.winner === 'con' ? C.con : C.dim;
  const swingText = (v.swing > 0 ? '+' : '') + String(v.swing);
  // As large as fits the box both ways, with room for the label under it and
  // for the corners the tilt swings outward.
  const label = textMask('NET SWING', 3, 4);
  const gap = 12;
  const maxSy = Math.floor((boxH - 44 - label.mh - gap) / 7);
  let ssx = Math.min(15, Math.floor(maxSy / 1.3));
  while (ssx > 4 && textWidth(swingText, ssx) > boxW - 48) ssx--;
  const ssy = Math.min(maxSy, Math.round(ssx * 1.3));
  const num = textMask(swingText, ssx, ssy);
  const pivotX = M + boxW / 2;
  const pivotY = top + boxH / 2;
  const stackH = num.mh + gap + label.mh;
  stampRotated(cv, num, pivotX, pivotY, -num.mw / 2, -stackH / 2, -1.5, winColor);
  stampRotated(cv, label, pivotX, pivotY, -label.mw / 2, -stackH / 2 + num.mh + gap, -1.5, C.muted);

  // Names and bars to the right of it.
  const colX = M + boxW + 48;
  const colW = W - M - colX;

  const pill = (side, name, x, y) => {
    const t = `${side.toUpperCase()} · ${foldText(name)}`;
    const pw = textWidth(t, 3) + 28;
    cv.rect(x, y, pw, 44, side === 'pro' ? C.pro : C.con);
    cv.text(t, x + 14, y + 8, 3, 4, C.paper);
    return pw;
  };
  const proT = `PRO · ${foldText(record.pro.name)}`;
  const conT = `CON · ${foldText(record.con.name)}`;
  const oneRow = textWidth(proT, 3) + textWidth(conT, 3) + 56 + 16 <= colW;
  let y = top;
  const pw = pill('pro', record.pro.name, colX, y);
  if (oneRow) {
    pill('con', record.con.name, colX + pw + 16, y);
    y += 44 + 26;
  } else {
    pill('con', record.con.name, colX, y + 52);
    y += 96 + 18;
  }

  // Opening and closing tallies on one scale. The shift between them is the
  // result, so they are drawn as one comparison, never two separate charts.
  const tagW = textWidth('OPENED', 2) + 18;
  const barX = colX + tagW;
  const barW = colW - tagW;
  const rowH = oneRow ? 30 : 22;
  const rowGap = oneRow ? 22 : 12;
  const drawBar = (tag, t, by) => {
    cv.text(tag, colX, by + Math.round((rowH - 21) / 2), 2, 3, C.dim);
    cv.rect(barX, by, barW, rowH, C.ruleHot);
    const inner = barW - 6;
    cv.rect(barX + 3, by + 3, inner, rowH - 6, C.plate);
    if (!v.panel) { cv.rect(barX + 3, by + 3, inner, rowH - 6, C.ruleHot); return; }
    const wPro = Math.round((t.pro / v.panel) * inner);
    const wCon = Math.round((t.con / v.panel) * inner);
    cv.rect(barX + 3, by + 3, wPro, rowH - 6, C.pro);
    cv.rect(barX + 3 + wPro, by + 3, inner - wPro - wCon, rowH - 6, C.ruleHot);
    cv.rect(barX + 3 + inner - wCon, by + 3, wCon, rowH - 6, C.con);
  };
  drawBar('OPENED', v.open, y);
  drawBar('CLOSED', v.close, y + rowH + rowGap);

  return encode(W, H, cv.px);
}

// Records never change once written, so neither does a card. Kept in memory
// so a link being shared around does not redraw the same pixels every time a
// crawler asks; capped so a scrape of every id cannot grow it without limit.
const CACHE_MAX = 64;
const cache = new Map();
function cardFor(record) {
  const hit = cache.get(record.id);
  if (hit) return hit;
  const png = render(record);
  cache.set(record.id, png);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return png;
}

module.exports = { W, H, render, cardFor, foldText };
