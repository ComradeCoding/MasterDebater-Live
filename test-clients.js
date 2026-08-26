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

function makeClient(label) {
  const ws = new WebSocket(URL);
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
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(TEST_PORT), ARCHIVE_DIR },
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

  [pro, con, v1, v2, v3, v4].forEach((c) => c.close());
  await wait(150);
}

(async () => {
  let proc = null;
  try {
    proc = await startServer();
    await run();
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
