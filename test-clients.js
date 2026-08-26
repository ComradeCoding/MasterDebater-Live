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
    env: { ...process.env, PORT: String(TEST_PORT), ARCHIVE_DIR, DEBATE_TURN_SECONDS: '1' },
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

  await runFormat();
}

// ==========================================================================
// The format: turns, the clock, and the floor
// ==========================================================================
// The server is spawned with DEBATE_TURN_SECONDS=1, so a full six-turn format
// runs in six seconds instead of thirteen minutes.

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
  check('the format is six turns', started.turn && started.turn.total === 6,
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
  for (let i = 0; i < 6; i++) {
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

  await runHomesite();
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
                       '/manifesto.gif', '/guestbook.gif', '/ring.png', '/bounce.js']) {
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
