'use strict';
//
// Protocol-level end-to-end tests for MasterDebater Live.
//
// Drives real WebSocket clients against a real server using Node 22's built-in
// global WebSocket. No test framework, no dependencies.
//
//   node test-clients.js                    # spawns its own server on :3111
//   TEST_URL=ws://localhost:3000 node test-clients.js   # use a running server
//
// Prints PASS/FAIL per check and exits nonzero if anything failed.

const { spawn } = require('child_process');
const path = require('path');

const TEST_PORT = Number(process.env.TEST_PORT) || 3111;
const URL = process.env.TEST_URL || `ws://localhost:${TEST_PORT}`;
const SPAWN_SERVER = !process.env.TEST_URL;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The permalink is plain HTTP, so the transport checks below are ordinary
// fetches rather than protocol messages.
const HTTP_ORIGIN = URL.replace(/^ws/, 'http');
async function fetchText(p) {
  const res = await fetch(HTTP_ORIGIN + p);
  return {
    status: res.status,
    body: await res.text(),
    csp: res.headers.get('content-security-policy'),
  };
}

// Archived debates are real files. Tests write to a throwaway directory so a
// run never lands in the developer's own archive.
const ARCHIVE_DIR = path.join(
  require('os').tmpdir(), `debate-test-archive-${process.pid}`
);

const CHALLENGE_TTL_MS = 2500;
const CHALLENGE_ORPHAN_MS = 700;

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

// --------------------------------------------------------------------------
// A tiny client mirroring the browser's socket wrapper
// --------------------------------------------------------------------------

function makeClient(label, url = URL) {
  const ws = new WebSocket(url);
  const listeners = {};
  const pending = new Map();
  const received = {}; // type -> [data], so tests can assert after the fact
  let nextId = 1;

  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error(`${label}: connection failed`)));
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.ackId != null) {
      const cb = pending.get(msg.ackId);
      pending.delete(msg.ackId);
      if (cb) cb(msg.data);
    } else if (msg.type) {
      (received[msg.type] = received[msg.type] || []).push(msg.data);
      (listeners[msg.type] || []).forEach((fn) => fn(msg.data));
    }
  });

  return {
    label,
    open,
    received,
    got: (type) => received[type] || [],
    on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    emit(type, data) {
      return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, type, data }));
      });
    },
    close() { ws.close(); },
  };
}

// --------------------------------------------------------------------------

async function startServer() {
  if (!SPAWN_SERVER) return null;
  return spawnServer(TEST_PORT, ARCHIVE_DIR, {
    DEBATE_TURN_SECONDS: '1',
    // A day and five minutes, collapsed so the board's timers can be watched.
    CHALLENGE_TTL_MS: String(CHALLENGE_TTL_MS), CHALLENGE_ORPHAN_MS: String(CHALLENGE_ORPHAN_MS),
  });
}

async function spawnServer(port, dir, extra) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), ARCHIVE_DIR: dir, ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 10s')), 10000);
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) { clearTimeout(timer); resolve(); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
  });
  return proc;
}

async function run() {
  const alice = makeClient('alice');   // → PRO
  const bob = makeClient('bob');       // → CON
  const carol = makeClient('carol');   // → audience
  await Promise.all([alice.open, bob.open, carol.open]);

  // --- lobby push on connect ---------------------------------------------
  await wait(100);
  check('lobby pushed on connect', Array.isArray(alice.got('lobby:rooms')[0]));

  // --- room creation ------------------------------------------------------
  const noTopic = await alice.emit('room:create', { topic: '   ' });
  check('empty topic rejected', !!noTopic.error, JSON.stringify(noTopic));

  const created = await alice.emit('room:create', { topic: 'AI will do more good than harm' });
  check('room creation acks a roomId', typeof created.roomId === 'string' && created.roomId.length > 0,
    JSON.stringify(created));
  const roomId = created.roomId;

  const badJoin = await carol.emit('room:join', { roomId: 'nope99', name: 'X' });
  check('joining a missing room errors', !!badJoin.error);

  // --- joining ------------------------------------------------------------
  const aJoin = await alice.emit('room:join', { roomId, name: 'Alice' });
  const bJoin = await bob.emit('room:join', { roomId, name: 'Bob' });
  const cJoin = await carol.emit('room:join', { roomId, name: '  ' }); // → "Guest"
  check('all joiners start as audience',
    aJoin.role === 'audience' && bJoin.role === 'audience' && cJoin.role === 'audience');
  check('room:join ack reports the full member state', cJoin.room && cJoin.room.audienceCount === 3);
  await wait(150);
  check('blank name falls back to Guest',
    alice.got('audience:system').some((s) => s.text === 'Guest joined the audience'),
    JSON.stringify(alice.got('audience:system')));

  // --- the stage is closed to the audience --------------------------------
  const blocked = await carol.emit('debate:message', { text: 'let me in!' });
  check('audience posting to the stage is rejected', !!blocked.error, JSON.stringify(blocked));

  // --- seats --------------------------------------------------------------
  const badSide = await alice.emit('seat:claim', { side: 'middle' });
  check('invalid side rejected', !!badSide.error);

  const aSeat = await alice.emit('seat:claim', { side: 'pro' });
  const bSeat = await bob.emit('seat:claim', { side: 'con' });
  check('both seats claimable', aSeat.role === 'pro' && bSeat.role === 'con',
    JSON.stringify({ aSeat, bSeat }));

  const stolen = await carol.emit('seat:claim', { side: 'pro' });
  check('third claim of a taken seat rejected', !!stolen.error, JSON.stringify(stolen));

  const doubleDip = await alice.emit('seat:claim', { side: 'con' });
  check('a seated debater cannot claim the other side', !!doubleDip.error);

  // --- messages + typing --------------------------------------------------
  const carolTyping = [];
  const aliceTyping = [];
  carol.on('debate:typing', (t) => carolTyping.push(t));
  alice.on('debate:typing', (t) => aliceTyping.push(t));

  await alice.emit('debate:typing', { isTyping: true });

  await alice.emit('debate:message', { text: 'AI accelerates medicine and science.' });
  await bob.emit('debate:message', { text: 'Concentrated power and job loss say otherwise.' });
  await carol.emit('audience:message', { text: 'Great points on both sides!' });
  await alice.emit('audience:message', { text: 'thanks all' }); // debater in the sidebar
  await wait(300);

  check('typing indicator relayed to others',
    carolTyping.some((t) => t.name === 'Alice' && t.role === 'pro' && t.isTyping === true));
  check('typing indicator not echoed to the sender', aliceTyping.length === 0);

  const carolDebate = carol.got('debate:message');
  const bobDebate = bob.got('debate:message');
  check('stage messages broadcast to every member',
    carolDebate.length === 2 && bobDebate.length === 2 &&
    carolDebate[0].role === 'pro' && carolDebate[1].role === 'con',
    JSON.stringify(carolDebate));
  check('stage messages carry monotonic ids',
    carolDebate[1].id > carolDebate[0].id);

  const carolAud = carol.got('audience:message');
  check('audience messages broadcast to every member',
    carolAud.some((m) => m.name === 'Guest' && m.text === 'Great points on both sides!'));
  check('a debater\'s sidebar message is tagged with their side',
    carolAud.some((m) => m.name === 'Alice' && m.role === 'pro'));

  const empty = await bob.emit('debate:message', { text: '   ' });
  check('empty-after-trim message rejected', !!empty.error);

  // --- late joiner --------------------------------------------------------
  const dave = makeClient('dave');
  await dave.open;
  const dJoin = await dave.emit('room:join', { roomId, name: 'Dave' });
  check('late joiner\'s ack contains the stage history', dJoin.debateMessages.length === 2,
    JSON.stringify(dJoin.debateMessages));
  check('late joiner\'s ack contains the audience history', dJoin.audienceMessages.length === 2);
  check('late joiner\'s ack has correct seat + audience state',
    dJoin.room.proTaken && dJoin.room.conTaken &&
    dJoin.room.proName === 'Alice' && dJoin.room.conName === 'Bob' &&
    dJoin.room.audienceCount === 2,
    JSON.stringify(dJoin.room));

  // --- oversized + markup input ------------------------------------------
  const nasty = '<script>alert(1)</script>' + 'x'.repeat(5000);
  const xss = await bob.emit('debate:message', { text: nasty });
  check('over-length markup message accepted', !!xss.ok, JSON.stringify(xss));
  await wait(200);
  const stored = carol.got('debate:message').slice(-1)[0];
  check('over-length message truncated server-side to 1000 chars',
    stored && stored.text.length === 1000, stored && String(stored.text.length));
  check('markup stored raw (escaping is the renderer\'s job)',
    stored && stored.text.startsWith('<script>alert(1)</script>'));

  // --- lobby reflects the live room ---------------------------------------
  const lobbyList = await new Promise((resolve) => {
    const fresh = makeClient('fresh');
    fresh.on('lobby:rooms', (list) => { resolve(list); fresh.close(); });
  });
  const listed = lobbyList.find((r) => r.id === roomId);
  check('lobby list includes the live room', !!listed);
  check('lobby entry carries seat names + audience count',
    listed && listed.proName === 'Alice' && listed.conName === 'Bob' && listed.audienceCount === 2,
    JSON.stringify(listed));

  // --- audience leaning ---------------------------------------------------
  // Members here: alice (PRO seat), bob (CON seat), carol + dave (audience).
  const tallies = [];
  carol.on('room:lean', (t) => tallies.push(t));
  const last = () => tallies[tallies.length - 1];

  check('joiners start neutral with an empty tally',
    dJoin.lean && dJoin.lean.pro === 0 && dJoin.lean.con === 0 && dJoin.myLean === null,
    JSON.stringify({ lean: dJoin.lean, myLean: dJoin.myLean }));

  const neutral = await carol.emit('audience:lean', { side: 'neutral' });
  check('there is no wire format for going back to neutral', !!neutral.error,
    JSON.stringify(neutral));

  const cLean = await carol.emit('audience:lean', { side: 'pro' });
  check('an audience member can pick a side', cLean.lean === 'pro', JSON.stringify(cLean));
  await dave.emit('audience:lean', { side: 'con' });
  await wait(200);
  check('the tally counts both picks', last().pro === 1 && last().con === 1,
    JSON.stringify(last()));

  const sysBefore = carol.got('audience:system').length;
  const tallyBefore = tallies.length;
  await carol.emit('audience:lean', { side: 'pro' }); // the side she already holds
  await wait(150);
  check('re-picking your own side is a no-op',
    carol.got('audience:system').length === sysBefore && tallies.length === tallyBefore);

  await carol.emit('audience:lean', { side: 'con' });
  await wait(200);
  check('flipping moves the tally both ways', last().pro === 0 && last().con === 2,
    JSON.stringify(last()));
  check('a flip is announced to the audience',
    carol.got('audience:system').some((m) => m.text === 'Guest flipped to CON'),
    JSON.stringify(carol.got('audience:system').slice(-3)));

  const beforeSeated = tallies.length;
  const aLean = await alice.emit('audience:lean', { side: 'pro' }); // alice holds PRO
  await wait(150);
  check('a seated debater cannot pad their own tally',
    !!aLean.ok && tallies.length === beforeSeated, JSON.stringify(aLean));

  await dave.emit('room:leave');
  await wait(200);
  check('leaving takes your vote with you', last().pro === 0 && last().con === 1,
    JSON.stringify(last()));

  // --- seat release -------------------------------------------------------
  const released = await bob.emit('seat:release');
  check('seat:release returns the caller to audience', released.role === 'audience');
  await wait(200);
  check('release is visible to others via room:state',
    carol.got('room:state').slice(-1)[0].conTaken === false);
  const afterRelease = await bob.emit('debate:message', { text: 'still here?' });
  check('a released debater can no longer post to the stage', !!afterRelease.error);

  // --- disconnect frees the seat ------------------------------------------
  const seatFreed = new Promise((resolve) => {
    carol.on('room:state', (r) => { if (!r.proTaken) resolve(true); });
    setTimeout(() => resolve(false), 2000);
  });
  alice.close();
  check('a debater\'s disconnect frees the seat', await seatFreed);

  // --- cleanup ------------------------------------------------------------
  [bob, carol, dave].forEach((c) => c.close());
  await wait(200);

  await runVerdict();
}

// ==========================================================================
// The verdict: entry stance, conclusion, archive, permalink
// ==========================================================================

async function runVerdict() {
  const pro = makeClient('pro');
  const con = makeClient('con');
  // Four in the audience with known opening stances, so the arithmetic below
  // is checked against a hand-computed answer rather than against itself.
  const v1 = makeClient('v1'); // undecided → pro
  const v2 = makeClient('v2'); // con       → pro   (crosses the floor)
  const v3 = makeClient('v3'); // pro       → pro   (never moves)
  const v4 = makeClient('v4'); // undecided → con, then leaves before the end
  await Promise.all([pro.open, con.open, v1.open, v2.open, v3.open, v4.open]);

  const { roomId } = await pro.emit('room:create', { topic: 'Homework should be abolished' });

  await pro.emit('room:join', { roomId, name: 'Nadia', stance: 'pro', voterId: 'w-pro' });
  await con.emit('room:join', { roomId, name: 'Roman', stance: 'con', voterId: 'w-con' });
  const j1 = await v1.emit('room:join', { roomId, name: 'V1', stance: 'undecided', voterId: 'w-1' });
  await v2.emit('room:join', { roomId, name: 'V2', stance: 'con', voterId: 'w-2' });
  await v3.emit('room:join', { roomId, name: 'V3', stance: 'pro', voterId: 'w-3' });
  await v4.emit('room:join', { roomId, name: 'V4', stance: 'undecided', voterId: 'w-4' });

  check('an opening stance is recorded at join', j1.myEntry === null && j1.myLean === null);
  const j2again = await v2.emit('room:join', { roomId, name: 'V2', stance: 'pro', voterId: 'w-2' });
  check('an entry stance cannot be rewritten by re-joining', j2again.myEntry === 'con',
    JSON.stringify(j2again.myEntry));

  await wait(120);
  const tally = v1.got('room:lean').slice(-1)[0];
  check('the live tally counts the undecided', tally && tally.undecided >= 1, JSON.stringify(tally));

  // --- can't call it before there is anything to judge ---------------------
  const early = await v1.emit('debate:conclude');
  check('the audience cannot call it', !!early.error);

  await pro.emit('seat:claim', { side: 'pro' });
  const tooEarly = await pro.emit('debate:conclude');
  check('cannot conclude with a seat still open', !!tooEarly.error, JSON.stringify(tooEarly));

  await con.emit('seat:claim', { side: 'con' });
  const noCase = await pro.emit('debate:conclude');
  check('cannot conclude before both sides have spoken', !!noCase.error, JSON.stringify(noCase));

  await pro.emit('debate:message', { text: 'It crowds out everything that makes a childhood.' });
  const oneSided = await pro.emit('debate:conclude');
  check('cannot conclude on a one-sided transcript', !!oneSided.error, JSON.stringify(oneSided));
  await con.emit('debate:message', { text: 'Practice is how a skill stops being fragile.' });
  // Stored raw, escaped by the renderer, the same guarantee the live page
  // makes. Now checked on the archived copy too.
  await v1.emit('audience:message', { text: '<script>alert(1)</script>' });

  // --- the room moves ------------------------------------------------------
  await v1.emit('audience:lean', { side: 'pro' });
  await v2.emit('audience:lean', { side: 'pro' });
  await v3.emit('audience:lean', { side: 'pro' });
  await v4.emit('audience:lean', { side: 'con' });
  await v4.emit('room:leave'); // walks out, but the ballot must still count
  await wait(120);

  // Panel is the four voters; the two debaters are struck.
  //   open  pro 1 (v3), con 1 (v2), undecided 2 (v1, v4)  → margin  0
  //   close pro 3 (v1, v2, v3), con 1 (v4)                → margin +2
  const done = await con.emit('debate:conclude');
  check('a seated debater can call it', !done.error, JSON.stringify(done));
  const v = done.result && done.result.verdict;
  check('the panel excludes both debaters', v && v.panel === 4, JSON.stringify(v && v.panel));
  check('the opening tally is the stance taken at the door',
    v && v.open.pro === 1 && v.open.con === 1 && v.open.undecided === 2, JSON.stringify(v && v.open));
  check('the closing tally counts a voter who already left',
    v && v.close.pro === 3 && v.close.con === 1, JSON.stringify(v && v.close));
  check('swing is the shift in margin, not the head-count', v && v.swing === 2, String(v && v.swing));
  check('the winner is the side that moved the room', v && v.winner === 'pro', v && v.winner);
  check('crossing the floor is counted separately', v && v.moved.crossed === 1,
    JSON.stringify(v && v.moved));
  check('the record carries one headline for every renderer',
    typeof done.result.headline === 'string' && done.result.headline.includes('Nadia'),
    done.result.headline);

  // --- a settled debate is frozen -----------------------------------------
  await wait(120);
  check('everyone in the room is told it concluded', v1.got('room:concluded').length === 1);
  const afterMsg = await pro.emit('debate:message', { text: 'one more thing' });
  check('the stage is closed once settled', !!afterMsg.error);
  const afterChat = await v1.emit('audience:message', { text: 'wait' });
  check('the sidebar is closed once settled', !!afterChat.error);
  const afterLean = await v1.emit('audience:lean', { side: 'con' });
  check('the vote is closed once settled', !!afterLean.error);
  const afterSeat = await v3.emit('seat:claim', { side: 'pro' });
  check('seats cannot change once settled', !!afterSeat.error);

  const rejoin = await v3.emit('room:join', { roomId, name: 'V3', voterId: 'w-3' });
  check('a settled debate cannot be re-entered', !!rejoin.error);
  check('the rejection points at the permalink', rejoin.resultUrl === `/d/${roomId}`,
    JSON.stringify(rejoin.resultUrl));

  await wait(120);
  const settled = v1.got('lobby:results').slice(-1)[0];
  check('the settled list is pushed to everyone',
    Array.isArray(settled) && settled.some((r) => r.id === roomId), JSON.stringify(settled));
  const live = v1.got('lobby:rooms').slice(-1)[0];
  check('a settled debate drops off the live floor',
    Array.isArray(live) && !live.some((r) => r.id === roomId));

  // --- the permalink -------------------------------------------------------
  const page = await fetchText(`/d/${roomId}`);
  check('the permalink serves the record', page.status === 200 && page.body.includes('Homework'),
    String(page.status));
  check('the permalink states the verdict', page.body.includes('+2'));
  check('the permalink carries the transcript',
    page.body.includes('crowds out') && page.body.includes('stops being fragile'));
  check('the permalink runs no script', /script-src 'none'/.test(page.csp || ''), page.csp);

  const missing = await fetchText('/d/000000');
  check('an unknown permalink is a 404, not an error', missing.status === 404);
  const traversal = await fetchText('/d/..%2F..%2Fserver.js');
  check('a traversal attempt in the id is rejected', traversal.status === 404, String(traversal.status));

  // --- markup in the record stays inert ------------------------------------
  check('names and messages are escaped on the permalink',
    !page.body.includes('<script>alert'), 'raw markup reached the page');

  // --- the share card --------------------------------------------------------
  const cardRes = await fetch(`${HTTP_ORIGIN}/d/${roomId}/card.png`);
  const cardBytes = Buffer.from(await cardRes.arrayBuffer());
  check('the share card serves for a real debate',
    cardRes.status === 200 && cardRes.headers.get('content-type') === 'image/png',
    `${cardRes.status} ${cardRes.headers.get('content-type')}`);
  check('the share card is a real 1200x630 PNG',
    cardBytes.subarray(1, 4).toString() === 'PNG' &&
    cardBytes.readUInt32BE(16) === 1200 && cardBytes.readUInt32BE(20) === 630,
    cardBytes.subarray(0, 24).toString('hex'));
  check('the share card runs under the same no-script policy',
    /script-src 'none'/.test(cardRes.headers.get('content-security-policy') || ''));
  const noCard = await fetch(`${HTTP_ORIGIN}/d/000000/card.png`);
  check('an unknown debate has no share card', noCard.status === 404, String(noCard.status));
  const badCard = await fetch(`${HTTP_ORIGIN}/d/..%2Fserver.js/card.png`);
  check('a traversal attempt on the card is rejected', badCard.status === 404, String(badCard.status));
  check('the permalink names the card as its preview image',
    page.body.includes(`/d/${roomId}/card.png"`) &&
    /<meta property="og:image" content="https?:\/\/[^"]+\/card\.png">/.test(page.body));
  check('the permalink asks for a large twitter card',
    page.body.includes('<meta name="twitter:card" content="summary_large_image">'));

  // --- rematch ---------------------------------------------------------------
  // Nadia argued PRO and Roman CON. A rematch swaps them.
  const audienceRematch = await v1.emit('room:rematch');
  check('the audience cannot call a rematch', !!audienceRematch.error, JSON.stringify(audienceRematch));

  const pushed = new Promise((resolve) => {
    con.on('room:rematch', (d) => resolve(d));
    setTimeout(() => resolve(null), 2000);
  });
  const rematch = await pro.emit('room:rematch');
  check('a debater can call a rematch', typeof rematch.roomId === 'string' && rematch.roomId !== roomId,
    JSON.stringify(rematch && rematch.roomId));
  check('the rematch lands the caller seated on the other side',
    rematch.join && rematch.join.role === 'con', JSON.stringify(rematch.join && rematch.join.role));
  const theirs = await pushed;
  check('the other debater is pushed into the rematch on the other side',
    theirs && theirs.roomId === rematch.roomId && theirs.join && theirs.join.role === 'pro',
    JSON.stringify(theirs && { roomId: theirs.roomId, role: theirs.join && theirs.join.role }));
  check('the rematch room has both seats swapped',
    rematch.join && rematch.join.room.proName === 'Roman' && rematch.join.room.conName === 'Nadia' &&
    rematch.join.room.topic === 'Homework should be abolished',
    JSON.stringify(rematch.join && rematch.join.room));
  await wait(120);
  check('everyone else is handed a link to the rematch',
    v1.got('debate:system').some((s) => s.roomId === rematch.roomId && /Rematch/.test(s.text)),
    JSON.stringify(v1.got('debate:system').slice(-2)));
  const again2 = await con.emit('room:rematch');
  check('asking twice does not open a second rematch', again2.roomId === rematch.roomId,
    JSON.stringify(again2.roomId));
  const fresh = await pro.emit('debate:message', { text: 'Round two.' });
  check('the rematch is a live room the debaters can argue in', !fresh.error, JSON.stringify(fresh));

  [pro, con, v1, v2, v3, v4].forEach((c) => c.close());
  await wait(150);

  await runFormat();
}

// ==========================================================================
// The format: turns, the clock, and the floor
// ==========================================================================
// The server is spawned with DEBATE_TURN_SECONDS=1, so a full eight-turn format
// runs in eight seconds instead of seventeen minutes.

async function runFormat() {
  const pro = makeClient('fpro');
  const con = makeClient('fcon');
  const watcher = makeClient('fwatch');
  await Promise.all([pro.open, con.open, watcher.open]);

  const { roomId } = await pro.emit('room:create', { topic: 'Juries should be abolished' });
  await pro.emit('room:join', { roomId, name: 'Ines', stance: 'pro', voterId: 'g-pro' });
  await con.emit('room:join', { roomId, name: 'Tomas', stance: 'con', voterId: 'g-con' });
  const wJoin = await watcher.emit('room:join', { roomId, name: 'Wren', stance: 'undecided', voterId: 'g-w' });

  check('a room starts with no format running', wJoin.turn && wJoin.turn.started === false,
    JSON.stringify(wJoin.turn));

  await pro.emit('seat:claim', { side: 'pro' });

  // --- starting -----------------------------------------------------------
  const audienceStart = await watcher.emit('debate:start');
  check('the audience cannot call the room to order', !!audienceStart.error);
  const oneSeat = await pro.emit('debate:start');
  check('cannot start with a seat still open', !!oneSeat.error, JSON.stringify(oneSeat));

  // Before the format starts the stage is open, which is the old behaviour.
  const warmup = await pro.emit('debate:message', { text: 'testing, testing' });
  check('the stage is open before the room is called to order', !warmup.error,
    JSON.stringify(warmup));

  await con.emit('seat:claim', { side: 'con' });
  const started = await con.emit('debate:start');
  check('a seated debater can start it', !started.error, JSON.stringify(started));
  check('PRO opens', started.turn && started.turn.side === 'pro' && started.turn.round === 'Opening',
    JSON.stringify(started.turn));
  // Derived from the table in format.js: two turns a round, four rounds.
  check('the format is eight turns, two for each round in the table',
    started.turn && started.turn.total === 8 && started.turn.total === 2 * require('./format').ROUNDS.length,
    String(started.turn && started.turn.total));
  const twice = await pro.emit('debate:start');
  check('it cannot be started twice', !!twice.error);

  // --- the floor is enforced ----------------------------------------------
  const outOfTurn = await con.emit('debate:message', { text: 'let me in' });
  check('the side without the floor cannot post', !!outOfTurn.error, JSON.stringify(outOfTurn));
  const onTurn = await pro.emit('debate:message', { text: 'Twelve amateurs decide nothing well.' });
  check('the side with the floor can post', !onTurn.error);
  const again = await pro.emit('debate:message', { text: 'A turn is a window, not one message.' });
  check('a turn allows more than one message', !again.error);

  // --- yielding -----------------------------------------------------------
  const wrongYield = await con.emit('debate:pass');
  check('you cannot yield a floor you do not hold', !!wrongYield.error);
  await pro.emit('debate:pass');
  await wait(150);
  const afterPass = watcher.got('debate:turn').slice(-1)[0];
  check('yielding hands the floor to the other side',
    afterPass && afterPass.side === 'con' && afterPass.index === 1, JSON.stringify(afterPass));
  const proBlocked = await pro.emit('debate:message', { text: 'one more' });
  check('the side that yielded is locked out', !!proBlocked.error);
  await con.emit('debate:message', { text: 'A jury is the one check a state cannot staff.' });

  // --- the clock advances on its own --------------------------------------
  const before = watcher.got('debate:turn').length;
  await wait(2500);
  const ticked = watcher.got('debate:turn').slice(-1)[0];
  check('the clock advances the turn without anyone acting',
    watcher.got('debate:turn').length > before && ticked.index > 1, JSON.stringify(ticked));
  check('running out of time is announced',
    watcher.got('debate:system').some((s) => /out of time/.test(s.text)));

  // --- a seat emptying stops the clock -------------------------------------
  await con.emit('seat:release');
  await wait(150);
  const paused = watcher.got('debate:turn').slice(-1)[0];
  check('an empty seat stops the clock', paused && paused.paused === true, JSON.stringify(paused));
  const whilePaused = await pro.emit('debate:message', { text: 'free hit?' });
  check('nobody can post while the clock is stopped', !!whilePaused.error);

  const heldIndex = paused.index;
  await con.emit('seat:claim', { side: 'con' });
  await wait(150);
  const resumed = watcher.got('debate:turn').slice(-1)[0];
  check('refilling the seat restarts the clock', resumed && resumed.paused === false,
    JSON.stringify(resumed));
  check('the turn resumes where it stopped rather than restarting',
    resumed.index === heldIndex, `${resumed.index} vs ${heldIndex}`);

  // --- the format settles the debate on its own ----------------------------
  await watcher.emit('audience:lean', { side: 'pro' });
  const ended = new Promise((resolve) => {
    watcher.on('room:concluded', (d) => resolve(d));
    setTimeout(() => resolve(null), 15000);
  });
  // Drive the remaining turns by yielding, posting on each side as it comes up
  // so the transcript stays two-sided and the auto-settle guard is satisfied.
  for (let i = 0; i < 8; i++) {
    const t = watcher.got('debate:turn').slice(-1)[0];
    if (!t || !t.started) break;
    const who = t.side === 'pro' ? pro : con;
    await who.emit('debate:message', { text: `round ${t.round} from ${t.side}` });
    await who.emit('debate:pass');
    await wait(200);
  }
  const conclusion = await ended;
  check('the last turn settles the debate with nobody pressing anything',
    !!(conclusion && conclusion.result), JSON.stringify(conclusion && conclusion.url));
  check('the auto-settled record is a normal record',
    !!(conclusion && conclusion.result && conclusion.result.verdict && conclusion.result.headline),
    JSON.stringify(conclusion && conclusion.result && conclusion.result.headline));

  const page = await fetchText(`/d/${roomId}`);
  check('the auto-settled debate has a permalink', page.status === 200 && page.body.includes('Juries'),
    String(page.status));

  [pro, con, watcher].forEach((c) => c.close());
  await wait(150);

  await runQuestions();
}

// ==========================================================================
// The floor's questions
// ==========================================================================
// Turns are one second each here, so every step inside a round is a single
// quick round trip and the turns are handed over by yielding, never by waiting
// for the clock.

async function runQuestions() {
  const pro = makeClient('qpro');
  const con = makeClient('qcon');
  const a1 = makeClient('qa1');
  const a2 = makeClient('qa2');
  const a3 = makeClient('qa3');
  await Promise.all([pro.open, con.open, a1.open, a2.open, a3.open]);

  const { roomId } = await pro.emit('room:create', { topic: 'Cities should ban cars' });
  await pro.emit('room:join', { roomId, name: 'Pia', stance: 'pro', voterId: 'q-pro' });
  await con.emit('room:join', { roomId, name: 'Cyril', stance: 'con', voterId: 'q-con' });
  await a1.emit('room:join', { roomId, name: 'Asha', stance: 'undecided', voterId: 'q-1' });
  await a2.emit('room:join', { roomId, name: 'Bram', stance: 'undecided', voterId: 'q-2' });
  await a3.emit('room:join', { roomId, name: 'Cleo', stance: 'undecided', voterId: 'q-3' });
  await pro.emit('seat:claim', { side: 'pro' });
  await con.emit('seat:claim', { side: 'con' });

  const early = await a1.emit('audience:question', { text: 'Too soon?' });
  check('no questions before the rebuttals', !!early.error, JSON.stringify(early));

  // Opening, both sides, handed over by yielding.
  await pro.emit('debate:start');
  await pro.emit('debate:message', { text: 'Streets are for people.' });
  await pro.emit('debate:pass');
  await con.emit('debate:message', { text: 'Streets are for deliveries too.' });
  await con.emit('debate:pass');

  // Rebuttal, PRO: the floor asks and votes now.
  const fromStage = await pro.emit('audience:question', { text: 'Can I ask myself?' });
  const q1 = await a1.emit('audience:question', { text: 'Who pays for the buses?' });
  const q2 = await a2.emit('audience:question', { text: '<img src=x onerror=alert(1)>' });
  const second = await a1.emit('audience:question', { text: 'And another thing' });
  const ownVote = await a1.emit('audience:upvote', { questionId: q1.questionId });
  await a2.emit('audience:upvote', { questionId: q1.questionId });
  await a3.emit('audience:upvote', { questionId: q1.questionId });
  await a1.emit('audience:upvote', { questionId: q2.questionId });
  const doubled = await a2.emit('audience:upvote', { questionId: q1.questionId });

  check('the stage cannot ask the floor\'s questions', !!fromStage.error, JSON.stringify(fromStage));
  check('the audience can ask during the rebuttals', q1.ok && q2.ok, JSON.stringify([q1, q2]));
  check('one question per audience member', !!second.error, JSON.stringify(second));
  check('nobody can vote for their own question', !!ownVote.error, JSON.stringify(ownVote));
  check('a second vote on the same question does not count twice', doubled.votes === 2,
    JSON.stringify(doubled));

  await wait(60);
  const ranked = a3.got('room:questions').slice(-1)[0] || [];
  check('questions are pushed ranked by votes',
    ranked.length === 2 && ranked[0].id === q1.questionId && ranked[0].votes === 2 && ranked[1].votes === 1,
    JSON.stringify(ranked));
  check('the question list never names who voted or their ballot id',
    !/q-[123]/.test(JSON.stringify(ranked)), JSON.stringify(ranked));

  await pro.emit('debate:message', { text: 'Buses pay for themselves in cleared lanes.' });
  await pro.emit('debate:pass');
  await con.emit('debate:message', { text: 'Not in a town of nine thousand.' });
  await con.emit('debate:pass');
  await wait(60);

  // Questions, PRO answers first.
  const qTurn = a1.got('debate:turn').slice(-1)[0];
  check('a Questions round follows the rebuttals, PRO first',
    qTurn && qTurn.round === 'Questions' && qTurn.side === 'pro' && qTurn.answering === true,
    JSON.stringify(qTurn));
  check('the top-voted question is pinned for the side answering',
    qTurn && qTurn.question && qTurn.question.text === 'Who pays for the buses?' && qTurn.question.pinned,
    JSON.stringify(qTurn && qTurn.question));
  const lateVote = await a3.emit('audience:upvote', { questionId: q2.questionId });
  check('voting closes when the questions round opens', !!lateVote.error, JSON.stringify(lateVote));
  const lateAsk = await a3.emit('audience:question', { text: 'Am I too late?' });
  check('asking closes when the questions round opens', !!lateAsk.error);

  const latecomer = makeClient('qlate');
  await latecomer.open;
  const lj = await latecomer.emit('room:join', { roomId, name: 'Dov', stance: 'pro', voterId: 'q-late' });
  check('a late arrival sees the pinned question',
    lj.turn && lj.turn.question && lj.turn.question.id === q1.questionId && lj.questions.length === 2,
    JSON.stringify(lj.turn && lj.turn.question));

  await pro.emit('debate:message', { text: 'The drivers who no longer need the lanes.' });
  await pro.emit('debate:pass');
  await wait(60);
  const conTurn = a1.got('debate:turn').slice(-1)[0];
  check('CON answers the same question',
    conTurn && conTurn.side === 'con' && conTurn.question && conTurn.question.id === q1.questionId,
    JSON.stringify(conTurn));
  await con.emit('debate:message', { text: 'The same drivers, twice.' });
  await con.emit('debate:pass');
  await wait(60);
  const closing = a1.got('debate:turn').slice(-1)[0];
  check('the pin comes down for the closings',
    closing && closing.round === 'Closing' && closing.question === null, JSON.stringify(closing));

  // Settle and read the record.
  const done = await con.emit('debate:conclude');
  const rq = done.result && done.result.questions;
  check('the questions live in the record',
    Array.isArray(rq) && rq.length === 2 && rq[0].text === 'Who pays for the buses?' &&
    rq[0].votes === 2 && rq[0].pinned === true && rq[1].pinned === false,
    JSON.stringify(rq));
  check('the record keeps no ballot ids for questions', !/q-[123]/.test(JSON.stringify(rq)));
  const page = await fetchText(`/d/${roomId}`);
  check('the permalink renders the questions under the transcript',
    page.body.includes('Questions from the floor') && page.body.includes('Who pays for the buses?') &&
    page.body.indexOf('Questions from the floor') > page.body.indexOf('Not in a town of nine thousand.'));
  check('a question is escaped on the permalink', !page.body.includes('<img src=x'),
    'raw markup reached the page');

  [pro, con, a1, a2, a3, latecomer].forEach((c) => c.close());
  await wait(150);

  await runArchive();
}

// ==========================================================================
// The archive page
// ==========================================================================
// Three debates are settled by now, with swings the earlier sections checked
// by hand: homework +2 with one crossing, juries +1, cities 0. Settled in that
// order, so newest first is the reverse.

async function runArchive() {
  const order = (body, ...topics) => {
    const at = topics.map((t) => body.indexOf(t));
    return at.every((i) => i >= 0) && at.every((i, k) => k === 0 || at[k - 1] < i);
  };
  const H = 'Homework should be abolished';
  const J = 'Juries should be abolished';
  const C = 'Cities should ban cars';

  const page = await fetchText('/archive');
  check('the archive lists every settled debate', page.status === 200 &&
    page.body.includes(H) && page.body.includes(J) && page.body.includes(C), String(page.status));
  check('the archive runs no script', /script-src 'none'/.test(page.csp || ''), page.csp);
  check('the archive\'s only relaxation is its own search form',
    /form-action 'self'/.test(page.csp || '') && (page.csp || '').split("'unsafe-inline'").length === 2,
    page.csp);
  check('the archive opens newest first', order(page.body, C, J, H));
  check('it sorts by biggest swing', order((await fetchText('/archive?sort=swing')).body, H, J, C));
  check('it sorts by most contested, smallest margin first',
    order((await fetchText('/archive?sort=contested')).body, C, J, H));
  check('an unknown sort falls back to newest',
    order((await fetchText('/archive?sort=constructor')).body, C, J, H));

  const byMotion = (await fetchText('/archive?q=juries+abolished')).body;
  check('search finds a motion by every word in it', byMotion.includes(J) && !byMotion.includes(H));
  const byName = (await fetchText('/archive?q=NADIA')).body;
  check('search finds a debater by name, ignoring case', byName.includes(H) && !byName.includes(J));
  const both = (await fetchText('/archive?q=abolished&sort=swing')).body;
  check('search and sort combine', order(both, H, J) && !both.includes(C));
  const nothing = (await fetchText('/archive?q=zzqqxx')).body;
  check('a search with no hits says so', /Nothing on the record matches/.test(nothing));
  const nasty = await fetchText('/archive?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  check('the search terms are escaped on the way back out',
    nasty.status === 200 && !nasty.body.includes('<script>alert'));
  check('a search result asks not to be indexed',
    nasty.body.includes('<meta name="robots" content="noindex">') &&
    !page.body.includes('<meta name="robots" content="noindex">'));

  const map = await fetchText('/sitemap.xml');
  check('the sitemap lists the archive', /<loc>[^<]*\/archive<\/loc>/.test(map.body));
  const app = await fetchText('/');
  check('the lobby links to the archive', app.body.includes('href="/archive"'));

  await runHandles();
}

// ==========================================================================
// Handles
// ==========================================================================

async function runHandles() {
  const KEY_N = 'a1'.repeat(32);   // Nadia's browser
  const KEY_X = 'b2'.repeat(32);   // somebody else's
  const KEY_R = 'c3'.repeat(32);   // Roman's browser
  const nad = makeClient('hnad');
  const rom = makeClient('hrom');
  const imp = makeClient('himp');
  const vot = makeClient('hvot');
  await Promise.all([nad.open, rom.open, imp.open, vot.open]);

  const { roomId } = await nad.emit('room:create', { topic: 'Remote work beats the office' });
  await nad.emit('room:join', { roomId, name: 'Nadia', stance: 'pro', voterId: 'h-nad' });
  await rom.emit('room:join', { roomId, name: 'Roman', stance: 'con', voterId: 'h-rom' });
  await imp.emit('room:join', { roomId, name: 'Nadia', stance: 'con', voterId: 'h-imp' });
  await vot.emit('room:join', { roomId, name: 'Vee', stance: 'undecided', voterId: 'h-vot' });

  const badShape = await nad.emit('seat:claim', { side: 'pro', handle: 'n', secret: KEY_N });
  check('a handle has a shape', !!badShape.error, JSON.stringify(badShape));
  const noKey = await nad.emit('seat:claim', { side: 'pro', handle: 'nadia_k', secret: 'short' });
  check('a handle needs a full browser key', !!noKey.error, JSON.stringify(noKey));

  const first = await nad.emit('seat:claim', { side: 'pro', handle: 'Nadia_K', secret: KEY_N });
  check('the first claim of a handle binds it', first.ok && first.handle === 'nadia_k',
    JSON.stringify(first));
  await wait(60);
  const st = vot.got('room:state').slice(-1)[0];
  check('the handle is stored on the seat', st && st.proHandle === 'nadia_k', JSON.stringify(st));
  check('the browser key never reaches anyone else', !JSON.stringify(vot.received).includes(KEY_N));

  const stolen = await imp.emit('seat:claim', { side: 'con', handle: 'nadia_k', secret: KEY_X });
  check('a different key gets "handle taken"', stolen.error === 'handle taken', JSON.stringify(stolen));
  await wait(60);
  check('a refused handle claim does not take the seat',
    vot.got('room:state').slice(-1)[0].conTaken === false);

  await rom.emit('seat:claim', { side: 'con', handle: 'roman-o', secret: KEY_R });
  await nad.emit('debate:message', { text: 'Nobody misses the commute.' });
  await rom.emit('debate:message', { text: 'Everybody misses the corridor conversation.' });
  await vot.emit('audience:lean', { side: 'con' });
  const done = await rom.emit('debate:conclude');
  check('the handles are in the record',
    done.result && done.result.pro.handle === 'nadia_k' && done.result.con.handle === 'roman-o',
    JSON.stringify(done.result && [done.result.pro, done.result.con]));
  check('the record carries no key', !JSON.stringify(done.result).includes(KEY_N));

  // The same browser, a new connection, a new room: the key still opens it.
  const nad2 = makeClient('hnad2');
  await nad2.open;
  const { roomId: r2 } = await nad2.emit('room:create', { topic: 'Second outing' });
  await nad2.emit('room:join', { roomId: r2, name: 'Nadia', stance: 'pro', voterId: 'h-nad' });
  const again = await nad2.emit('seat:claim', { side: 'pro', handle: 'nadia_k', secret: KEY_N });
  check('the same key claims the handle again from anywhere', again.ok && again.handle === 'nadia_k',
    JSON.stringify(again));
  await nad2.emit('seat:release');

  // Anonymous seats still work: a handle is optional.
  const anon = await nad2.emit('seat:claim', { side: 'con' });
  check('a seat can still be taken with no handle', anon.ok && anon.handle === null,
    JSON.stringify(anon));

  // --- the debater's page -------------------------------------------------
  const lost = await fetchText('/u/nadia_k');
  check('a debater\'s page lists what they argued', lost.status === 200 &&
    lost.body.includes('Remote work beats the office'), String(lost.status));
  check('it shows side, swing and result from their side',
    /lost<\/span> as <span class="pro">PRO/.test(lost.body) && lost.body.includes('>-1<'),
    lost.body.slice(lost.body.indexOf('<div class="list">'), lost.body.indexOf('<div class="list">') + 400));
  check('it keeps a running total', lost.body.includes('running -1') && /Net moved/.test(lost.body));
  const won = await fetchText('/u/roman-o');
  check('the other side of the same debate reads as a win',
    /won<\/span> as <span class="con">CON/.test(won.body) && won.body.includes('>+1<'));
  check('a debater\'s page runs no script', /script-src 'none'/.test(lost.csp || ''), lost.csp);
  check('nobody under an unclaimed handle is a 404', (await fetchText('/u/nobody-here')).status === 404);
  check('a traversal attempt in a handle is a 404',
    (await fetchText('/u/..%2F..%2Fserver.js')).status === 404);
  check('the key never appears on the page', !lost.body.includes(KEY_N));
  const perma = await fetchText(`/d/${roomId}`);
  check('the permalink links each handle to its page',
    perma.body.includes('href="/u/nadia_k"') && perma.body.includes('href="/u/roman-o"'));

  [nad, rom, imp, vot, nad2].forEach((c) => c.close());
  await wait(150);

  await runChallenges();
}

// ==========================================================================
// The challenge board
// ==========================================================================
// The server runs with a 2.5 second expiry and a 0.7 second orphan window, so
// each challenge below is taken or withdrawn well inside its lifetime, and the
// two timed deaths are watched on purpose at the end.

async function runChallenges() {
  const ann = makeClient('ann');     // posts
  const ben = makeClient('ben');     // accepts
  const cat = makeClient('cat');     // just watching the board
  await Promise.all([ann.open, ben.open, cat.open]);
  await wait(80);
  const latest = () => cat.got('lobby:challenges').slice(-1)[0] || [];
  check('the board is pushed on connect', Array.isArray(cat.got('lobby:challenges')[0]),
    JSON.stringify(cat.got('lobby:challenges')[0]));

  const noMotion = await ann.emit('challenge:post', { motion: '  ', side: 'pro', name: 'Ann' });
  check('a challenge needs a motion', !!noMotion.error);
  const noSide = await ann.emit('challenge:post', { motion: 'Cats beat dogs', side: 'both', name: 'Ann' });
  check('a challenge needs a side', !!noSide.error);

  const posted = await ann.emit('challenge:post',
    { motion: 'Cats beat dogs', side: 'con', name: 'Ann', voterId: 'ch-ann' });
  check('a visitor can post a motion and take one side',
    posted.ok && posted.challenge && posted.challenge.side === 'con' && posted.challenge.name === 'Ann',
    JSON.stringify(posted));
  await wait(80);
  check('the challenge goes up on everyone\'s board',
    latest().some((c) => c.id === posted.challenge.id && c.motion === 'Cats beat dogs'));
  check('the board never shows the poster\'s browser id',
    !JSON.stringify(latest()).includes('ch-ann'), JSON.stringify(latest()));

  const twice = await ann.emit('challenge:post', { motion: 'Second one', side: 'pro', name: 'Ann' });
  check('one challenge per person at a time', !!twice.error, JSON.stringify(twice));
  const own = await ann.emit('challenge:accept', { challengeId: posted.challenge.id });
  check('you cannot take the other side of your own challenge', !!own.error);

  const out = await ann.emit('challenge:withdraw');
  await wait(80);
  check('withdrawing takes it off the board',
    out.ok && !latest().some((c) => c.id === posted.challenge.id));

  // --- a match -------------------------------------------------------------
  const real = await ann.emit('challenge:post',
    { motion: 'Cats beat dogs', side: 'con', name: 'Ann', voterId: 'ch-ann' });
  const annFound = new Promise((r) => { ann.on('match:found', r); setTimeout(() => r(null), 2000); });
  const benFound = new Promise((r) => { ben.on('match:found', r); setTimeout(() => r(null), 2000); });
  const took = await ben.emit('challenge:accept',
    { challengeId: real.challenge.id, name: 'Ben', voterId: 'ch-ben' });
  check('someone can accept the other side', took.ok && typeof took.roomId === 'string', JSON.stringify(took));
  const [a, b] = await Promise.all([annFound, benFound]);
  check('both are pushed match:found with the same room',
    a && b && a.roomId === took.roomId && b.roomId === took.roomId,
    JSON.stringify([a && a.roomId, b && b.roomId, took.roomId]));
  check('the poster arrives seated on the side they posted',
    a && a.join.role === 'con' && a.join.room.conName === 'Ann', JSON.stringify(a && a.join.room));
  check('the taker arrives seated on the other side',
    b && b.join.role === 'pro' && b.join.room.proName === 'Ben', JSON.stringify(b && b.join.room));
  check('the matched room carries the motion', b && b.join.room.topic === 'Cats beat dogs');
  await wait(80);
  check('a taken challenge comes off the board', !latest().some((c) => c.id === real.challenge.id));
  const argue = await ben.emit('debate:message', { text: 'Dogs need you; cats tolerate you.' });
  check('the matched pair can argue straight away', !argue.error, JSON.stringify(argue));
  const gone = await cat.emit('challenge:accept', { challengeId: real.challenge.id, name: 'Cat' });
  check('a taken challenge cannot be taken twice', !!gone.error);

  const lobby = cat.got('lobby:rooms').slice(-1)[0];
  check('the matched room is on the live floor',
    lobby && lobby.some((r) => r.id === took.roomId && r.proTaken && r.conTaken));

  // --- a seated debater cannot be pulled out of a live debate ---------------
  const busy = await ben.emit('challenge:post', { motion: 'Mid-debate', side: 'pro', name: 'Ben' });
  const pull = await cat.emit('challenge:accept', { challengeId: busy.challenge.id, name: 'Cat' });
  check('a poster in a live seat cannot be matched out of it', !!pull.error, JSON.stringify(pull));
  await ben.emit('challenge:withdraw');

  // --- the poster stepping away -------------------------------------------
  const dan = makeClient('dan');
  await dan.open;
  const dans = await dan.emit('challenge:post',
    { motion: 'Pineapple belongs on pizza', side: 'pro', name: 'Dan', voterId: 'ch-dan' });
  dan.close();
  await wait(120);
  const away = latest().find((c) => c.id === dans.challenge.id);
  check('a dropped poster\'s challenge stays up, marked away', away && away.away === true,
    JSON.stringify(away));
  const whileAway = await cat.emit('challenge:accept', { challengeId: dans.challenge.id, name: 'Cat' });
  check('nobody can take a challenge while its poster is away', !!whileAway.error);

  const dan2 = makeClient('dan2');
  await dan2.open;
  const back = await dan2.emit('challenge:reclaim', { voterId: 'ch-dan' });
  check('a reload reclaims the challenge before it dies', back.challengeId === dans.challenge.id,
    JSON.stringify(back));
  await wait(CHALLENGE_ORPHAN_MS + 200);
  const kept = latest().find((c) => c.id === dans.challenge.id);
  check('a reclaimed challenge survives the grace period', kept && kept.away === false,
    JSON.stringify(kept));
  await dan2.emit('challenge:withdraw');
  dan2.close();

  const eve = makeClient('eve');
  await eve.open;
  const eves = await eve.emit('challenge:post',
    { motion: 'Tabs over spaces', side: 'con', name: 'Eve', voterId: 'ch-eve' });
  eve.close();
  await wait(CHALLENGE_ORPHAN_MS + 300);
  check('a challenge dies when its poster stays away past the grace period',
    !latest().some((c) => c.id === eves.challenge.id));

  // --- expiry ----------------------------------------------------------------
  const old = await cat.emit('challenge:post',
    { motion: 'Nothing lasts', side: 'pro', name: 'Cat', voterId: 'ch-cat' });
  await wait(CHALLENGE_TTL_MS + 300);
  check('a challenge expires when nobody takes it in time',
    !latest().some((c) => c.id === old.challenge.id));

  [ann, ben, cat].forEach((c) => c.close());
  await wait(150);

  await runHomesite();
  runGif();
}

// ==========================================================================
// Surviving a restart
// ==========================================================================
// A second server on its own port and its own directory, killed outright in
// the middle of a debate (no chance to shut down cleanly, the worst case) and
// started again on the same directory.

async function runRestart() {
  if (!SPAWN_SERVER) return;
  const port = TEST_PORT + 1;
  const dir = path.join(require('os').tmpdir(), `debate-test-restart-${process.pid}`);
  const url = `ws://localhost:${port}`;
  const http = `http://localhost:${port}`;
  const KEY = 'd4'.repeat(32);
  let proc = await spawnServer(port, dir, { DEBATE_TURN_SECONDS: '30' });

  try {
    const p = makeClient('rpro', url);
    const c = makeClient('rcon', url);
    const w = makeClient('rwatch', url);
    const poster = makeClient('rposter', url);
    await Promise.all([p.open, c.open, w.open, poster.open]);

    const { roomId } = await p.emit('room:create', { topic: 'Restarts should be survivable' });
    await p.emit('room:join', { roomId, name: 'Pat', stance: 'pro', voterId: 'r-pro' });
    await c.emit('room:join', { roomId, name: 'Cas', stance: 'con', voterId: 'r-con' });
    await w.emit('room:join', { roomId, name: 'Wim', stance: 'con', voterId: 'r-w' });
    await p.emit('seat:claim', { side: 'pro', handle: 'pat-r', secret: KEY });
    await c.emit('seat:claim', { side: 'con' });
    const m1 = await p.emit('debate:message', { text: 'Before the crash.' });
    await c.emit('debate:message', { text: 'Also before the crash.' });
    await w.emit('audience:message', { text: 'watching' });
    await w.emit('audience:lean', { side: 'pro' });
    await poster.emit('challenge:post',
      { motion: 'Crashes are character building', side: 'pro', name: 'Ray', voterId: 'r-poster' });
    await p.emit('debate:start');
    await wait(200);
    const lastId = p.got('debate:message').slice(-1)[0].id;
    void m1;

    [p, c, w, poster].forEach((x) => x.close());
    proc.kill('SIGKILL');
    await new Promise((r) => proc.once('exit', r));
    proc = await spawnServer(port, dir, { DEBATE_TURN_SECONDS: '30' });

    const back = makeClient('rback', url);
    await back.open;
    await wait(100);
    const live = (back.got('lobby:rooms')[0] || []).find((r) => r.id === roomId);
    check('a live room survives the server being killed', !!live, JSON.stringify(back.got('lobby:rooms')[0]));
    check('its seats come back held for the people who sat in them',
      live && live.proName === 'Pat' && live.proAway === true && live.conAway === true && live.proHandle === 'pat-r',
      JSON.stringify(live));
    const ch = (back.got('lobby:challenges')[0] || []).find((x) => x.motion === 'Crashes are character building');
    check('challenges survive, marked away until their poster reconnects', ch && ch.away === true,
      JSON.stringify(ch));

    // The watcher's browser comes back.
    const w2 = makeClient('rwatch2', url);
    await w2.open;
    const wj = await w2.emit('room:join', { roomId, name: 'Wim', stance: 'undecided', voterId: 'r-w' });
    check('the transcript survives',
      wj.debateMessages.some((m) => m.text === 'Before the crash.') &&
      wj.audienceMessages.some((m) => m.text === 'watching'), JSON.stringify(wj.debateMessages));
    check('the stage says the server restarted',
      wj.debateMessages.some((m) => m.role === 'system' && /server restarted/i.test(m.text)));
    check('ballots survive: the entry stance and the lean both come back',
      wj.myEntry === 'con' && wj.myLean === 'pro', JSON.stringify([wj.myEntry, wj.myLean]));
    check('the clock comes back paused, on the same turn, with its time',
      wj.turn && wj.turn.started && wj.turn.paused && wj.turn.index === 0 &&
      wj.turn.remainingMs > 25000 && wj.turn.remainingMs <= 30000 &&
      /restarted/.test(wj.turn.pausedReason || ''), JSON.stringify(wj.turn));

    const snipe = await w2.emit('seat:claim', { side: 'pro' });
    check('a held seat cannot be taken by someone else', !!snipe.error && /held/.test(snipe.error),
      JSON.stringify(snipe));

    const p2 = makeClient('rpro2', url);
    const c2 = makeClient('rcon2', url);
    await Promise.all([p2.open, c2.open]);
    await p2.emit('room:join', { roomId, name: 'Pat', stance: 'pro', voterId: 'r-pro' });
    await c2.emit('room:join', { roomId, name: 'Cas', stance: 'con', voterId: 'r-con' });
    const reclaim = await p2.emit('seat:claim', { side: 'pro', handle: 'pat-r', secret: KEY });
    check('the debater\'s own browser gets the held seat back', reclaim.ok, JSON.stringify(reclaim));
    await c2.emit('seat:claim', { side: 'con' });
    await wait(100);
    const running = w2.got('debate:turn').slice(-1)[0];
    check('the clock runs again once both are back', running && running.paused === false && running.index === 0,
      JSON.stringify(running));
    const after = await p2.emit('debate:message', { text: 'After the crash.' });
    await wait(80);
    const newest = w2.got('debate:message').slice(-1)[0];
    check('message ids keep counting up across the restart', !after.error && newest && newest.id > lastId,
      JSON.stringify([lastId, newest && newest.id]));

    const thief = makeClient('rthief', url);
    await thief.open;
    const { roomId: other } = await thief.emit('room:create', { topic: 'Somewhere else' });
    await thief.emit('room:join', { roomId: other, name: 'Pat', stance: 'pro', voterId: 'r-thief' });
    const taken = await thief.emit('seat:claim', { side: 'pro', handle: 'pat-r', secret: 'e5'.repeat(32) });
    check('handles survive the restart', taken.error === 'handle taken', JSON.stringify(taken));

    // Settling deletes the live rows: a third start must not bring it back.
    await c2.emit('debate:conclude').catch(() => {});
    await p2.emit('debate:conclude');
    [back, w2, p2, c2, thief].forEach((x) => x.close());
    proc.kill('SIGKILL');
    await new Promise((r) => proc.once('exit', r));
    proc = await spawnServer(port, dir, { DEBATE_TURN_SECONDS: '30' });
    const third = makeClient('rthird', url);
    await third.open;
    await wait(100);
    const settledGone = !(third.got('lobby:rooms')[0] || []).some((r) => r.id === roomId);
    const perma = await fetch(`${http}/d/${roomId}`);
    check('a settled debate is not restored as live, and its permalink stands',
      settledGone && perma.status === 200, `${settledGone} ${perma.status}`);
    third.close();
  } finally {
    proc.kill('SIGKILL');
    try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ==========================================================================
// The mothership: Host-routed homepage
// ==========================================================================
// fetch() refuses to override the Host header, so these checks speak raw
// http. That is also the honest test: production routing runs on exactly
// this header.

function rawGet(p, host) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: TEST_PORT, path: p, headers: host ? { Host: host } : {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({
          status: res.statusCode,
          body,
          csp: res.headers['content-security-policy'],
          type: res.headers['content-type'],
        }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runHomesite() {
  const home = await rawGet('/', 'comradecoding.com');
  check('the bare domain serves the homepage',
    home.status === 200 && home.body.includes('COMRADECODING.COM'), String(home.status));
  check('www serves the homepage too',
    (await rawGet('/', 'www.comradecoding.com')).body.includes('COMRADECODING.COM'));
  check('the homepage bans inline script', /script-src 'self'/.test(home.csp || '') && !/unsafe-inline/.test((home.csp || '').split('style-src')[0]), home.csp);
  check('the homepage links to MasterDebater', /masterdebater/i.test(home.body));
  check('the homepage links to Athletics',
    /href="https:\/\/foot\.comradecoding\.com">Athletics<\/a>/.test(home.body));
  // The music is synthesized into a blob and played through an <audio>
  // element. Without media-src the policy blocks it and the only symptom the
  // visitor gets is silence.
  check('the homepage policy allows its synthesized audio',
    /media-src[^;]*blob:/.test(home.csp || ''), home.csp);

  // --- the bouncing corner -------------------------------------------------
  // A running page cannot be checked for this: the interesting cases are an
  // edge hit, a window smaller than he is, and the long delta a backgrounded
  // tab hands back on return. All three live in one pure function.
  const bounce = require('./homesite/bounce');
  const box = { W: 1000, H: 800, w: 200, h: 250 };
  let s = { x: 700, y: 36, vx: -33, vy: 32 };
  let outside = 0;
  let turns = 0;
  for (let i = 0; i < 4000; i++) {
    const before = { vx: s.vx, vy: s.vy };
    s = bounce.step(s, 1 / 60, box);
    if (Math.sign(s.vx) !== Math.sign(before.vx) || Math.sign(s.vy) !== Math.sign(before.vy)) turns++;
    if (s.x < bounce.MARGIN - 0.5 || s.y < bounce.MARGIN - 0.5 ||
        s.x > box.W - box.w - bounce.MARGIN + 0.5 || s.y > box.H - box.h - bounce.MARGIN + 0.5) outside++;
  }
  check('he never leaves the window', outside === 0, `${outside} frames outside`);
  check('he turns at the edges', turns >= 4, `${turns} direction changes in 66 simulated seconds`);

  // A tab left in the background hands back a gap of minutes on return. Without
  // the cap that single step would throw him far outside the window.
  const jumped = bounce.step({ x: 500, y: 400, vx: -33, vy: 32 }, 600, box);
  check('a long gap between frames cannot fling him out of the window',
    jumped.x >= bounce.MARGIN && jumped.y >= bounce.MARGIN &&
    jumped.x <= box.W - box.w && jumped.y <= box.H - box.h, JSON.stringify(jumped));

  // Narrower than he is: he should settle, not vibrate against both walls.
  const tight = { W: 100, H: 100, w: 200, h: 250 };
  let t1 = bounce.step({ x: 50, y: 50, vx: -33, vy: 32 }, 1 / 60, tight);
  const t2 = bounce.step(t1, 1 / 60, tight);
  check('a window smaller than he is parks him instead of jittering',
    t1.x === t2.x && t1.y === t2.y, JSON.stringify([t1, t2]));

  // --- crawlers ------------------------------------------------------------
  const robots = await rawGet('/robots.txt', 'comradecoding.com');
  check('robots.txt is served',
    robots.status === 200 && /text\/plain/.test(robots.type || ''), String(robots.status));
  check('robots.txt points at the sitemap', /Sitemap: https?:\/\/\S+\/sitemap\.xml/.test(robots.body),
    robots.body);

  const map = await rawGet('/sitemap.xml', 'comradecoding.com');
  check('sitemap.xml is served as xml',
    map.status === 200 && /application\/xml/.test(map.type || ''), String(map.status));
  check('the sitemap lists the homepage and the arena',
    /<loc>[^<]*\/<\/loc>/.test(map.body) && /<loc>[^<]*\/arena<\/loc>/.test(map.body), map.body.slice(0, 200));
  // Settled debates are the pages worth finding, so they have to be in there.
  check('the sitemap lists settled debates with a date',
    /<loc>[^<]*\/d\/[0-9a-f]{6}<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(map.body),
    map.body.slice(0, 400));

  // The clip art is the only thing the page loads, and it loads by absolute
  // path, so it has to serve from the home root on every host exactly as the
  // script does.
  for (const asset of ['/marx.gif', '/bowie.png', '/sickle.gif', '/trotsky.png',
                       '/manifesto.gif', '/guestbook.gif', '/ring.png', '/bounce.js', '/athletics.png']) {
    const onHome = await rawGet(asset, 'comradecoding.com');
    const elsewhere = await rawGet(asset, 'debate.comradecoding.com');
    check(`${asset} serves on both hosts`,
      onHome.status === 200 && elsewhere.status === 200,
      `${onHome.status} / ${elsewhere.status}`);
  }
  const gifType = await rawGet('/marx.gif', 'comradecoding.com');
  check('gifs are served as image/gif, not a download',
    /image\/gif/.test(gifType.type || ''), gifType.type);

  const midi = await rawGet('/midi.js', 'comradecoding.com');
  check('the homepage script is served on the home host',
    midi.status === 200 && midi.body.includes('internationale'), String(midi.status));
  // The page reaches other hosts by path but asks for its script at the root,
  // so this must serve everywhere or /home renders silent off the bare domain.
  const midiElsewhere = await rawGet('/midi.js', 'debate.comradecoding.com');
  check('the homepage script is served on any host',
    midiElsewhere.status === 200 && midiElsewhere.body.includes('internationale'),
    String(midiElsewhere.status));

  const app = await rawGet('/', 'debate.comradecoding.com');
  check('any other host still serves the app',
    app.status === 200 && app.body.includes('MasterDebater <span>Live</span>'), String(app.status));

  const byPath = await rawGet('/home', 'debate.comradecoding.com');
  check('/home serves the homepage from any host',
    byPath.status === 200 && byPath.body.includes('COMRADECODING.COM'), String(byPath.status));

  // The arena under the umbrella: the app is reachable at /arena on the home
  // host, so MasterDebater is hosted at comradecoding.com/arena with no
  // subdomain needed.
  const arena = await rawGet('/arena', 'comradecoding.com');
  check('/arena serves the app on the home host',
    arena.status === 200 && arena.body.includes('MasterDebater <span>Live</span>'),
    String(arena.status));

  // The two roots must not bleed into each other.
  const cross = await rawGet('/../public/index.html', 'comradecoding.com');
  check('the homepage root cannot reach the app root', cross.status !== 200, String(cross.status));
}


// ==========================================================================
// The GIF codec
// ==========================================================================
// LZW is the part of this repository with no second opinion available: get
// the code width wrong by one and the picture is noise, and nothing in the
// page will tell you, because a browser draws a corrupt GIF without
// complaining. So the compressor is tested against its own decompressor over
// the awkward sizes, and the decompressor is tested against the clip art on
// the homepage, which was written by encoders that are not ours.

function runGif() {
  const gif = require('./tools/gif');
  const fs = require('fs');
  const os = require('os');
  const pathmod = require('path');

  // A repeatable stand-in for random. A failure that only shows up one run in
  // ten is worse than no test at all.
  let seed = 20260826;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  let clean = true;
  let widest = 0;
  for (const minCodeSize of [2, 3, 4, 7, 8]) {
    const values = 1 << minCodeSize;
    for (const len of [1, 2, 3, 17, 255, 256, 1000, 40000]) {
      const noise = Buffer.alloc(len);
      const runs = Buffer.alloc(len);
      const flat = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        noise[i] = rnd(values);
        runs[i] = ((i / 37) | 0) % values;
      }
      for (const src of [noise, runs, flat]) {
        const round = gif.lzwDecode(gif.lzwEncode(src, minCodeSize), minCodeSize, len);
        if (Buffer.compare(src, round) !== 0) clean = false;
        widest = Math.max(widest, len);
      }
    }
  }
  check('LZW survives a round trip at every code width', clean,
    'noise, long runs and a flat buffer, up to ' + widest + ' pixels');

  // Enough distinct sequences to push the dictionary past 511, 1023, 2047 and
  // 4095, which is where an off-by-one in the widening rule shows up, and past
  // 4096, where the table fills and has to be thrown away and rebuilt.
  const overflow = Buffer.alloc(300000);
  for (let i = 0; i < overflow.length; i++) overflow[i] = rnd(256);
  check('LZW rebuilds its dictionary when it fills',
    Buffer.compare(overflow, gif.lzwDecode(gif.lzwEncode(overflow, 8), 8, overflow.length)) === 0);

  // The clip art on the homepage, decoded, re-encoded, and decoded again. The
  // frames that come back must be the frames that went in: same count, same
  // transparency, same colours. This is the check that catches a wrong
  // disposal method or a patch rectangle that does not cover what it wiped,
  // neither of which is visible in a single frame.
  const homesite = pathmod.join(__dirname, 'homesite');
  for (const name of ['sickle', 'manifesto', 'guestbook', 'marx']) {
    const file = pathmod.join(homesite, name + '.gif');
    if (!fs.existsSync(file)) { check('clip art ' + name + '.gif exists', false); continue; }
    const src = gif.read(file);
    const tmp = pathmod.join(os.tmpdir(), 'gif-test-' + process.pid + '-' + name + '.gif');
    let back = null;
    try {
      gif.write(tmp, src.w, src.h, src.frames, {});
      back = gif.read(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }

    let alphaMismatch = 0;
    let worst = 0;
    const frames = Math.min(src.frames.length, back.frames.length);
    for (let i = 0; i < frames; i++) {
      const a = src.frames[i].rgba;
      const b = back.frames[i].rgba;
      for (let o = 0; o < a.length; o += 4) {
        if ((a[o + 3] === 0) !== (b[o + 3] === 0)) { alphaMismatch++; continue; }
        if (a[o + 3] === 0) continue;
        worst = Math.max(worst,
          Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]));
      }
    }
    check(name + '.gif survives decode, encode and decode unchanged',
      src.frames.length === back.frames.length && alphaMismatch === 0 && worst === 0,
      src.frames.length + ' frames in, ' + back.frames.length + ' out, '
        + alphaMismatch + ' pixels disagreeing on transparency, worst channel ' + worst);
  }

  // The icons are drawn at a fixed size by the stylesheet, and the point of
  // shrinking them was to ship close to that size rather than twenty times it.
  // A future edit that drops a full resolution file back in should say so.
  const budget = { 'sickle.gif': 40000, 'manifesto.gif': 30000, 'guestbook.gif': 12000 };
  for (const [name, limit] of Object.entries(budget)) {
    const bytes = fs.statSync(pathmod.join(homesite, name)).size;
    check(name + ' stays under its weight budget', bytes <= limit,
      bytes + ' bytes, budget ' + limit);
  }

  // Drawn at 18, 22 and 26 pixels, so these want to be a whole multiple of
  // that and not one pixel off it. Shrinking by exactly two averages four
  // pixels into one; at one and a half the browser lands between pixels all
  // the way across and the icon looks worse than a smaller file would.
  const drawn = {
    'sickle.gif': [16, 18],
    'manifesto.gif': [22, 20],
    'guestbook.gif': [21, 26],
  };
  for (const [name, [dw, dh]] of Object.entries(drawn)) {
    const g = gif.read(pathmod.join(homesite, name));
    const rx = g.w / dw;
    const ry = g.h / dh;
    check(name + ' is a whole multiple of the size it is drawn at',
      rx === ry && rx === Math.round(rx) && rx >= 1,
      g.w + 'x' + g.h + ' against ' + dw + 'x' + dh + ', ratio ' + rx.toFixed(2) + ' by ' + ry.toFixed(2));
  }
}

(async () => {
  let proc = null;
  try {
    proc = await startServer();
    await run();
    await runRestart();
  } catch (err) {
    failures++;
    console.log(`FAIL  test harness crashed\n        ${err && err.stack ? err.stack : err}`);
  } finally {
    if (proc) proc.kill();
    try { require('fs').rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch {}
  }

  console.log(
    failures === 0
      ? `\nALL ${checks} CHECKS PASSED`
      : `\n${failures} of ${checks} CHECKS FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
