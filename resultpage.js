'use strict';
//
// The permalink page: a concluded debate rendered as a static document.
//
// This is the only page anyone outside the room ever sees, so it is the whole
// distribution story. Two constraints follow from that:
//
//   1. Zero JavaScript. It is a record, not an app, so it can be served under
//      `script-src 'none'`, a strictly tighter CSP than the live page, which
//      still needs 'unsafe-inline' for its one inline block.
//   2. Every interpolation is escaped here, at render time. The archive stores
//      raw text exactly as the live server does; nothing is trusted on the way
//      out. `esc` is the only way user text reaches this HTML.
//
// The hero is the swing number. Not the transcript, not the topic. It is the
// one figure that says whether anything actually happened.

const { verdictLine } = require('./verdict');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// UTC throughout: the server's timezone is an implementation detail, and a
// record that renders differently depending on where it is hosted is not a
// record.
function stamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// Transcript times are elapsed, not wall-clock: what matters when reading an
// argument back is the pacing, and elapsed times need no timezone.
function elapsed(ts, from) {
  const s = Math.max(0, Math.round((ts - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bar(t, panel) {
  if (!panel) return '<div class="bar"><span class="seg und" style="width:100%"></span></div>';
  const pct = (n) => (n / panel) * 100 + '%';
  return '<div class="bar">' +
    `<span class="seg pro" style="width:${pct(t.pro)}"></span>` +
    `<span class="seg und" style="width:${pct(t.undecided)}"></span>` +
    `<span class="seg con" style="width:${pct(t.con)}"></span>` +
  '</div>';
}

function countRow(t) {
  return `<span class="c pro">${t.pro} pro</span>` +
         `<span class="c und">${t.undecided} undecided</span>` +
         `<span class="c con">${t.con} con</span>`;
}

function transcript(messages, startedAt) {
  if (!messages.length) return '<div class="none">No arguments on the record.</div>';
  return '<div class="script">' + messages.map((m) => {
    const side = m.role === 'con' ? 'con' : 'pro';
    return `<div class="arg ${side}">` +
      `<div class="from">${esc(m.name)} · ${side.toUpperCase()} · ${elapsed(m.ts, startedAt)}</div>` +
      esc(m.text) +
    '</div>';
  }).join('') + '</div>';
}

function floorChat(messages) {
  if (!messages.length) return '';
  return '<div class="section-label">From the floor</div><div class="floor">' +
    messages.map((m) => {
      const role = m.role === 'pro' || m.role === 'con' ? m.role : 'audience';
      return `<div class="line"><span class="n ${role}">${esc(m.name)}:</span> ${esc(m.text)}</div>`;
    }).join('') + '</div>';
}

function render(record, origin) {
  const v = record.verdict;
  const proName = record.pro.name;
  const conName = record.con.name;
  const headline = record.headline || verdictLine(v, proName, conName);
  const swingSign = v.swing > 0 ? '+' : '';
  const winClass = v.winner === 'draw' ? 'draw' : v.winner;
  const url = `${origin}/d/${record.id}`;

  // Reused for the meta description and the link preview, which is the actual
  // unit of distribution here.
  const summary = `${proName} (PRO) vs ${conName} (CON). ${headline}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(record.topic)} | MasterDebater Live</title>
<meta name="description" content="${esc(summary)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(record.topic)}">
<meta property="og:description" content="${esc(summary)}">
<meta property="og:url" content="${esc(url)}">
<style>
  :root {
    --ink: #0a0b10; --ink-2: #101219; --plate: #161923;
    --rule: #262a38; --rule-hot: #3a3f52;
    --paper: #f4f1e9; --muted: #9aa0b0; --dim: #5f6577;
    --pro: #3d7dff; --pro-soft: rgba(61,125,255,.13);
    --con: #ff2d3f; --con-soft: rgba(255,45,63,.13);
    --neon: #b96bff; --neon-deep: #8b2fe6;
    --display: Bahnschrift, "DIN Condensed", "Franklin Gothic Medium", Impact, "Arial Narrow", sans-serif;
    --read: "Sitka Text", Constantia, Georgia, serif;
    --ui: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
    --data: "Cascadia Mono", Consolas, ui-monospace, monospace;
    --tilt: -1.5deg; --paste: 4px 4px 0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--ui); background: var(--ink); color: var(--paper); line-height: 1.5; }
  a { color: var(--neon); }
  ::selection { background: var(--neon-deep); color: #fff; }
  :focus-visible { outline: 2px solid var(--neon); outline-offset: 2px; }

  header {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 22px; background: var(--ink-2);
    border-bottom: 2px solid var(--paper);
  }
  .logo {
    font-family: var(--display); font-size: 19px; font-stretch: 87.5%;
    font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    color: var(--paper); text-decoration: none;
  }
  .logo span { background: var(--neon-deep); color: #fff; padding: 0 6px; }
  .settled {
    margin-left: auto; font-family: var(--data); font-size: 10px; font-weight: 700;
    letter-spacing: .2em; text-transform: uppercase; color: var(--dim);
  }

  .wrap { max-width: 860px; margin: 0 auto; padding: 44px 22px 80px; }

  .motion {
    font-family: var(--display); font-size: 44px; font-stretch: 75%;
    font-weight: 700; text-transform: uppercase; line-height: .96;
    letter-spacing: .01em; overflow-wrap: anywhere;
  }
  .card-meta {
    display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px;
    font-family: var(--data); font-size: 10px; font-weight: 700;
    letter-spacing: .16em; text-transform: uppercase;
  }
  .pill { padding: 4px 9px; }
  .pill.pro { background: var(--pro); color: var(--paper); }
  .pill.con { background: var(--con); color: var(--paper); }
  .pill.when { border: 2px solid var(--rule-hot); color: var(--dim); }

  /* ------------------------------------------------------- THE VERDICT -- */
  /* The one loud element on the page. Everything below it is quiet. */
  .verdict {
    margin: 34px 0 12px; padding: 24px 26px;
    background: var(--ink-2); border: 2px solid var(--paper);
    box-shadow: var(--paste) var(--neon);
    display: flex; gap: 28px; align-items: center; flex-wrap: wrap;
  }
  .swing { flex-shrink: 0; text-align: center; transform: rotate(var(--tilt)); }
  .swing .n {
    display: block; font-family: var(--display); font-size: 78px;
    font-stretch: 75%; font-weight: 700; line-height: .84; letter-spacing: -.01em;
  }
  .swing.pro .n { color: var(--pro); }
  .swing.con .n { color: var(--con); }
  .swing.draw .n { color: var(--dim); }
  .swing .k {
    display: block; margin-top: 8px; font-family: var(--data); font-size: 9px;
    font-weight: 700; letter-spacing: .22em; text-transform: uppercase; color: var(--muted);
  }
  .said { flex: 1; min-width: 240px; }
  .said .line {
    font-family: var(--display); font-size: 26px; font-stretch: 87.5%;
    font-weight: 700; text-transform: uppercase; line-height: 1.06; overflow-wrap: anywhere;
  }
  .said .detail {
    margin-top: 10px; font-family: var(--read); font-size: 14px; color: var(--muted);
  }

  /* Two bars, same scale, stacked. The shift between them IS the result, so
     they are drawn as one comparison rather than two separate charts. */
  .shift { margin: 22px 0 8px; }
  .shift .row { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
  .shift .tag {
    width: 62px; flex-shrink: 0; font-family: var(--data); font-size: 9.5px;
    font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--dim);
  }
  .shift .track { flex: 1; min-width: 0; }
  .bar { display: flex; height: 15px; border: 2px solid var(--rule-hot); background: var(--plate); }
  .bar .seg.pro { background: var(--pro); }
  .bar .seg.con { background: var(--con); }
  .bar .seg.und { background: var(--rule-hot); }
  .counts {
    display: flex; gap: 12px; margin-top: 6px;
    font-family: var(--data); font-size: 9.5px; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .counts .c.pro { color: var(--pro); }
  .counts .c.con { color: var(--con); }
  .counts .c.und { color: var(--muted); }

  .moved {
    font-family: var(--data); font-size: 10px; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase; color: var(--muted);
    padding-top: 14px; border-top: 2px solid var(--rule);
  }
  .moved b { color: var(--paper); }

  .section-label {
    display: flex; align-items: center; gap: 12px; margin: 44px 0 18px;
    font-family: var(--data); font-size: 10px; font-weight: 700;
    letter-spacing: .24em; text-transform: uppercase; color: var(--dim);
  }
  .section-label::after { content: ""; flex: 1; height: 2px; background: var(--rule); }

  /* The seam, same as the live stage: an argument cannot drift across it. */
  .script {
    display: grid; grid-template-columns: 1fr 1fr; column-gap: 46px; row-gap: 16px;
    align-content: start; padding: 4px 0;
    background: repeating-linear-gradient(var(--rule-hot) 0 6px, transparent 6px 12px) 50% 0 / 2px 100% no-repeat;
  }
  .arg {
    padding: 13px 16px; font-family: var(--read); font-size: 15px;
    line-height: 1.55; overflow-wrap: anywhere;
  }
  .arg .from {
    font-family: var(--data); font-size: 9.5px; font-weight: 700;
    letter-spacing: .2em; text-transform: uppercase; margin-bottom: 7px;
  }
  .arg.pro {
    grid-column: 1; justify-self: start;
    background: var(--pro-soft); border: 2px solid var(--pro);
    box-shadow: var(--paste) rgba(61,125,255,.35);
  }
  .arg.pro .from { color: var(--pro); }
  .arg.con {
    grid-column: 2; justify-self: end; text-align: right;
    background: var(--con-soft); border: 2px solid var(--con);
    box-shadow: var(--paste) rgba(255,45,63,.35);
  }
  .arg.con .from { color: var(--con); }

  .floor { border-top: 1px solid var(--rule); }
  .floor .line {
    font-size: 13.5px; padding: 7px 2px; border-bottom: 1px solid var(--rule);
    overflow-wrap: anywhere;
  }
  .floor .n { font-family: var(--data); font-size: 11.5px; font-weight: 700; }
  .floor .n.pro { color: var(--pro); }
  .floor .n.con { color: var(--con); }
  .floor .n.audience { color: var(--neon); }

  .none {
    font-family: var(--data); font-size: 11px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--dim);
    border: 2px dashed var(--rule-hot); padding: 26px; text-align: center;
  }

  footer {
    margin-top: 52px; padding-top: 20px; border-top: 2px solid var(--rule);
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
    font-family: var(--data); font-size: 10px; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase; color: var(--dim);
  }
  footer .perma { color: var(--muted); overflow-wrap: anywhere; }
  footer .go { margin-left: auto; }

  @media (max-width: 760px) {
    .motion { font-size: 32px; }
    .swing .n { font-size: 60px; }
    .verdict { gap: 18px; padding: 20px; }
    /* Phone: the columns stack, so the seam goes with them. */
    .script { display: flex; flex-direction: column; background: none; }
    .arg.con { text-align: left; }
    footer .go { margin-left: 0; }
  }
</style>
</head>
<body>
<header>
  <a class="logo" href="/">MasterDebater <span>Live</span></a>
  <div class="settled">Settled</div>
</header>

<div class="wrap">
  <h1 class="motion">${esc(record.topic)}</h1>
  <div class="card-meta">
    <span class="pill pro">PRO · ${esc(proName)}</span>
    <span class="pill con">CON · ${esc(conName)}</span>
    <span class="pill when">${esc(stamp(record.concludedAt))}</span>
  </div>

  <div class="verdict">
    <div class="swing ${winClass}">
      <span class="n">${swingSign}${v.swing}</span>
      <span class="k">Net swing</span>
    </div>
    <div class="said">
      <div class="line">${esc(headline)}</div>
      <div class="detail">${v.panel} ${v.panel === 1 ? 'person' : 'people'} gave a stance before reading anything, and could change it at any time.</div>
    </div>
  </div>

  <div class="shift">
    <div class="row">
      <div class="tag">Opened</div>
      <div class="track">${bar(v.open, v.panel)}<div class="counts">${countRow(v.open)}</div></div>
    </div>
    <div class="row">
      <div class="tag">Closed</div>
      <div class="track">${bar(v.close, v.panel)}<div class="counts">${countRow(v.close)}</div></div>
    </div>
    <div class="moved">
      <b>${v.moved.toPro}</b> moved to pro · <b>${v.moved.toCon}</b> moved to con ·
      <b>${v.moved.crossed}</b> crossed the floor outright · <b>${v.moved.held}</b> never budged
    </div>
  </div>

  <div class="section-label">The argument</div>
  ${transcript(record.debateMessages || [], record.createdAt)}
  ${floorChat(record.audienceMessages || [])}

  <footer>
    <span class="perma">${esc(url)}</span>
    <a class="go" href="/">Start your own →</a>
  </footer>
</div>
</body>
</html>`;
}

module.exports = { render, esc };
