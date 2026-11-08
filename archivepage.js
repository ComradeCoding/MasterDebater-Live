'use strict';
//
// The archive page: every settled debate the index holds, searchable and
// sortable, rendered on the server.
//
// Same discipline as the permalink. No JavaScript, so it runs under
// `script-src 'none'`. Search and sort are a plain GET form and plain links,
// which is all a list of records needs, and the URL is the whole state, so a
// search can be bookmarked and shared like anything else on the site.
//
// Every interpolation goes through `esc`, including the search terms echoed
// back into the box: a query string is user input like any other.

const { esc } = require('./resultpage');

const MAX_QUERY = 100;

// One stylesheet for the archive and the debater pages, which are the same
// kind of document: a list of records under the same masthead.
const STYLE = `  :root {
    --ink: #0a0b10; --ink-2: #101219; --plate: #161923;
    --rule: #262a38; --rule-hot: #3a3f52;
    --paper: #f4f1e9; --muted: #9aa0b0; --dim: #5f6577;
    --pro: #3d7dff; --con: #ff2d3f;
    --neon: #b96bff; --neon-deep: #8b2fe6;
    --display: Bahnschrift, "DIN Condensed", "Franklin Gothic Medium", Impact, "Arial Narrow", sans-serif;
    --ui: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
    --data: "Cascadia Mono", Consolas, ui-monospace, monospace;
    --tilt: -1.5deg; --paste: 4px 4px 0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--ui); background: var(--ink); color: var(--paper); line-height: 1.5; }
  a { color: var(--neon); }
  ::selection { background: var(--neon-deep); color: #fff; }
  :focus-visible { outline: 3px solid var(--neon); outline-offset: 3px; }

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
  .where {
    margin-left: auto; font-family: var(--data); font-size: 10px; font-weight: 700;
    letter-spacing: .2em; text-transform: uppercase; color: var(--dim);
  }

  .wrap { max-width: 860px; margin: 0 auto; padding: 44px 22px 80px; }
  h1 {
    font-family: var(--display); font-size: 56px; font-stretch: 75%;
    font-weight: 700; text-transform: uppercase; line-height: .92;
  }
  h1 span { display: inline-block; background: var(--paper); color: var(--ink); padding: .08em 10px 0; transform: rotate(var(--tilt)); }

  form { display: flex; gap: 10px; margin: 30px 0 16px; flex-wrap: wrap; }
  input[type=search] {
    flex: 1; min-width: 220px; font-family: var(--display); font-size: 18px;
    font-stretch: 87.5%; text-transform: uppercase; background: var(--ink-2); color: var(--paper);
    border: 2px solid var(--rule-hot); border-radius: 0; padding: 11px 13px;
  }
  input[type=search]:focus { border-color: var(--neon); outline: none; }
  button {
    font-family: var(--display); font-size: 14px; font-weight: 700; font-stretch: 87.5%;
    letter-spacing: .05em; text-transform: uppercase; cursor: pointer;
    background: var(--neon-deep); border: 2px solid var(--neon-deep); color: #fff;
    border-radius: 0; padding: 8px 18px; box-shadow: var(--paste) var(--paper);
  }
  button:hover { background: var(--paper); border-color: var(--paper); color: var(--ink); box-shadow: var(--paste) var(--neon); }

  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 22px; }
  .tab {
    font-family: var(--data); font-size: 10px; font-weight: 700; letter-spacing: .16em;
    text-transform: uppercase; padding: 6px 10px; border: 2px solid var(--rule-hot);
    color: var(--muted); text-decoration: none;
  }
  .tab:hover { border-color: var(--paper); color: var(--paper); }
  .tab.on { background: var(--paper); border-color: var(--paper); color: var(--ink); }
  .count {
    margin-left: auto; font-family: var(--data); font-size: 10px; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase; color: var(--dim);
  }

  .rec {
    display: flex; align-items: center; gap: 16px; padding: 14px 18px; margin-bottom: 10px;
    background: var(--ink-2); border: 2px solid var(--rule); color: inherit; text-decoration: none;
  }
  .rec:hover, .rec:focus-visible { border-color: var(--paper); box-shadow: var(--paste) var(--neon); }
  .rec .n {
    flex-shrink: 0; width: 64px; text-align: center; font-family: var(--display);
    font-size: 28px; font-stretch: 75%; font-weight: 700; line-height: 1;
  }
  .rec .n.pro { color: var(--pro); }
  .rec .n.con { color: var(--con); }
  .rec .n.draw { color: var(--dim); }
  .rec .info { flex: 1; min-width: 0; display: block; }
  .rec .t {
    display: block; font-family: var(--display); font-size: 18px; font-stretch: 87.5%;
    font-weight: 700; text-transform: uppercase; line-height: 1.1; overflow-wrap: anywhere;
  }
  .rec .meta {
    display: block; margin-top: 5px; font-family: var(--data); font-size: 9.5px; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase; color: var(--dim);
  }
  .rec .meta .pro { color: var(--pro); }
  .rec .meta .con { color: var(--con); }

  .none {
    font-family: var(--data); font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--dim); border: 2px dashed var(--rule-hot); padding: 26px; text-align: center;
  }
  .note {
    margin-top: 26px; font-family: var(--data); font-size: 9.5px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--dim);
  }

  @media (max-width: 760px) {
    h1 { font-size: 40px; }
    .count { margin-left: 0; flex-basis: 100%; }
    .rec { gap: 12px; padding: 12px 14px; }
    .rec .n { width: 46px; font-size: 22px; }
  }
`;

// Three orders, each answering a different question about the archive.
const SORTS = {
  // What happened lately.
  newest: (a, b) => b.concludedAt - a.concludedAt,
  // Where somebody actually moved the room, whichever way.
  swing: (a, b) => Math.abs(b.swing) - Math.abs(a.swing) || b.concludedAt - a.concludedAt,
  // The close ones: the smallest margin, then the most people changing sides
  // to get there, because a level result with a dozen crossings was a fight
  // and a level result with none was a room that never moved.
  contested: (a, b) =>
    Math.abs(a.swing) - Math.abs(b.swing) || (b.crossed | 0) - (a.crossed | 0) ||
    b.concludedAt - a.concludedAt,
};
const SORT_LABELS = { newest: 'Newest', swing: 'Biggest swing', contested: 'Most contested' };

const parseSort = (s) => (Object.hasOwn(SORTS, s) ? s : 'newest');

// Every word has to appear somewhere in the motion or either name, in any
// order. Case and accents are ignored, so "eleve" finds "élève".
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function matches(r, words) {
  const hay = fold(`${r.topic} ${r.proName} ${r.conName}`);
  return words.every((w) => hay.includes(w));
}

function select(list, query, sort) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return list.filter((r) => matches(r, words)).sort(SORTS[parseSort(sort)]);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

function row(r) {
  const side = r.winner === 'pro' || r.winner === 'con' ? r.winner : 'draw';
  const sign = r.swing > 0 ? '+' : '';
  const crossed = r.crossed | 0;
  return `<a class="rec" href="/d/${esc(r.id)}">` +
    `<span class="n ${side}">${sign}${r.swing | 0}</span>` +
    '<span class="info">' +
      `<span class="t">${esc(r.topic)}</span>` +
      '<span class="meta">' +
        `<span class="pro">${esc(r.proName)}</span> vs <span class="con">${esc(r.conName)}</span>` +
        ` · ${r.panel | 0} judging · ${crossed} crossed · ${esc(day(r.concludedAt))}` +
      '</span>' +
    '</span>' +
  '</a>';
}

function render(list, { query = '', sort = 'newest', origin = '', cap = Infinity } = {}) {
  query = String(query || '').slice(0, MAX_QUERY);
  sort = parseSort(sort);
  const shown = select(list, query, sort);
  const qs = (s) => `/archive?sort=${s}${query ? `&q=${encodeURIComponent(query)}` : ''}`;

  const tabs = Object.keys(SORTS).map((s) =>
    s === sort
      ? `<span class="tab on" aria-current="true">${SORT_LABELS[s]}</span>`
      : `<a class="tab" href="${esc(qs(s))}">${SORT_LABELS[s]}</a>`
  ).join('');

  const count = query
    ? `${shown.length} of ${list.length} match “${esc(query)}”`
    : `${list.length} settled debate${list.length === 1 ? '' : 's'}`;

  const body = shown.length
    ? `<div class="list">${shown.map(row).join('')}</div>`
    : `<div class="none">${list.length
        ? 'Nothing on the record matches that.'
        : 'Nothing has been settled yet. <a href="/arena">Go and settle something.</a>'}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The archive | MasterDebater Live</title>
<meta name="description" content="Every settled debate on MasterDebater Live, with who argued, who won and by how much.">
${query ? '<meta name="robots" content="noindex">' : ''}
<link rel="canonical" href="${esc(origin)}/archive">
<style>
${STYLE}</style>
</head>
<body>
<header>
  <a class="logo" href="/arena">MasterDebater <span>Live</span></a>
  <div class="where">Archive</div>
</header>
<main class="wrap">
  <h1>On the <span>record</span></h1>
  <form method="get" action="/archive" role="search">
    <input type="search" name="q" value="${esc(query)}" maxlength="${MAX_QUERY}"
           placeholder="Search motions and names" aria-label="Search motions and names">
    <input type="hidden" name="sort" value="${esc(sort)}">
    <button type="submit">Search</button>
  </form>
  <nav class="bar" aria-label="Sort the archive">
    ${tabs}
    <span class="count">${count}</span>
  </nav>
  ${body}
  ${list.length >= cap
    ? `<div class="note">The most recent ${list.length} are listed here. Older permalinks keep working; they are just not listed.</div>`
    : ''}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// A debater's page: /u/<handle>
// ---------------------------------------------------------------------------
// Every debate the handle argued, with its side, the swing, and the result
// from that debater's side of it. Swing is stored from PRO's point of view
// (positive means PRO moved the room), so it is flipped for a CON seat.
// The running total is the sum of those, oldest first: the number of people
// this debater has moved, net, across everything they have argued.

function careerOf(handle, list) {
  let total = 0;
  let won = 0;
  let lost = 0;
  let drew = 0;
  const rows = list.map((r) => {
    const side = r.proHandle === handle ? 'pro' : 'con';
    const mine = side === 'pro' ? r.swing | 0 : -(r.swing | 0);
    const result = mine > 0 ? 'won' : mine < 0 ? 'lost' : 'drew';
    if (result === 'won') won++; else if (result === 'lost') lost++; else drew++;
    total += mine;
    return {
      r, side, mine, result, running: total,
      name: side === 'pro' ? r.proName : r.conName,
      opponent: side === 'pro' ? r.conName : r.proName,
    };
  });
  return { rows, total, won, lost, drew };
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

function renderHandle(handle, list, { origin = '' } = {}) {
  const c = careerOf(handle, list);
  const totalClass = c.total > 0 ? 'pro' : c.total < 0 ? 'con' : 'draw';
  // Newest first on the page; the running figure on each row is the total as
  // it stood after that debate.
  const rows = c.rows.slice().reverse().map((x) =>
    `<a class="rec" href="/d/${esc(x.r.id)}">` +
      `<span class="n ${x.mine > 0 ? 'pro' : x.mine < 0 ? 'con' : 'draw'}">${signed(x.mine)}</span>` +
      '<span class="info">' +
        `<span class="t">${esc(x.r.topic)}</span>` +
        '<span class="meta">' +
          `<span class="res ${x.result}">${x.result}</span>` +
          ` as <span class="${x.side}">${x.side.toUpperCase()}</span>` +
          ` vs ${esc(x.opponent)} · ${esc(day(x.r.concludedAt))}` +
          ` · running ${signed(x.running)}` +
        '</span>' +
      '</span>' +
    '</a>'
  ).join('');

  const names = [...new Set(c.rows.map((x) => x.name))];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@${esc(handle)} | MasterDebater Live</title>
<meta name="description" content="@${esc(handle)}: ${c.rows.length} settled debate${c.rows.length === 1 ? '' : 's'}, ${c.won} won, ${c.lost} lost, ${c.drew} drawn, net ${signed(c.total)}.">
<link rel="canonical" href="${esc(origin)}/u/${esc(handle)}">
<style>
${STYLE}
  .career { display: flex; gap: 12px; flex-wrap: wrap; margin: 28px 0 30px; }
  .stat {
    padding: 12px 16px; background: var(--ink-2); border: 2px solid var(--rule-hot); min-width: 110px;
  }
  .stat .v {
    display: block; font-family: var(--display); font-size: 34px; font-stretch: 75%;
    font-weight: 700; line-height: .9;
  }
  .stat .k {
    display: block; margin-top: 6px; font-family: var(--data); font-size: 9px; font-weight: 700;
    letter-spacing: .2em; text-transform: uppercase; color: var(--muted);
  }
  .stat.total { border-color: var(--paper); box-shadow: var(--paste) var(--neon); transform: rotate(var(--tilt)); }
  .stat.total .v.pro { color: var(--pro); }
  .stat.total .v.con { color: var(--con); }
  .stat.total .v.draw { color: var(--dim); }
  .aka { margin-top: 12px; font-family: var(--data); font-size: 10px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--dim); }
  .res { color: var(--paper); }
  .res.won { color: var(--neon); }
</style>
</head>
<body>
<header>
  <a class="logo" href="/arena">MasterDebater <span>Live</span></a>
  <div class="where">Debater</div>
</header>
<main class="wrap">
  <h1><span>@${esc(handle)}</span></h1>
  ${names.length ? `<div class="aka">Argued as ${names.map(esc).join(', ')}</div>` : ''}
  <div class="career">
    <div class="stat total"><span class="v ${totalClass}">${signed(c.total)}</span><span class="k">Net moved</span></div>
    <div class="stat"><span class="v">${c.rows.length}</span><span class="k">Settled</span></div>
    <div class="stat"><span class="v">${c.won}</span><span class="k">Won</span></div>
    <div class="stat"><span class="v">${c.lost}</span><span class="k">Lost</span></div>
    <div class="stat"><span class="v">${c.drew}</span><span class="k">Drawn</span></div>
  </div>
  ${rows
    ? `<div class="list">${rows}</div>`
    : '<div class="none">Nothing settled under this handle yet.</div>'}
  <div class="note">A handle belongs to the browser that first claimed it. It is not an account.</div>
</main>
</body>
</html>`;
}

module.exports = { render, renderHandle, careerOf, select, SORTS, MAX_QUERY };
