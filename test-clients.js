'use strict';
//
// Protocol-level end-to-end tests for MasterDebater Live.
//
// Drives real WebSocket clients against a real server using Node 22's built-in
// global WebSocket — no test framework, no dependencies.
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
    env: { ...process.env, PORT: String(TEST_PORT) },
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
  }

  console.log(
    failures === 0
      ? `\nALL ${checks} CHECKS PASSED`
      : `\n${failures} of ${checks} CHECKS FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
