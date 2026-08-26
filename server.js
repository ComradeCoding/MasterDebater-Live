'use strict';
//
// MasterDebater Live: a real-time debate platform with two seated debaters on a
// central stage, an unlimited audience chatting alongside them.
//
// Zero dependencies. Built-in `http` for static files, a hand-rolled RFC 6455
// WebSocket server for the realtime layer.
//
//   node server.js      →  http://localhost:3000
//
// Layout of this file:
//   1. WebSocket transport   (RFC 6455 handshake + framing)
//   2. Store                 (in-memory rooms; the only place state lives)
//   3. Handlers              (protocol logic; talks to the store, not to sockets)
//   4. HTTP + wiring         (static serving, upgrade, heartbeat)
//
// The handler layer only touches `store` and the broadcast helpers, so swapping
// the Map-backed store for Postgres/SQLite means rewriting section 2 alone.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Three stdlib-only modules, still zero dependencies. They are split out
// because a concluded debate outlives the process and the live room does not:
// everything below section 2 is about the live room, and these three are about
// the record it leaves behind.
const { computeVerdict, verdictLine } = require('./verdict');
const archive = require('./archive');
const resultpage = require('./resultpage');
const format = require('./format');

const PORT = Number(process.env.PORT) || 3000;

// ===========================================================================
// 1. WebSocket transport
// ===========================================================================

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// The largest legitimate protocol message is ~1KB of JSON; anything bigger is
// an attack or a bug, and buffering it per-connection is a memory DoS vector.
const MAX_FRAME = 64 * 1024;
// A peer that stops reading makes socket.write() buffer in our memory. Past
// this backlog the connection is dropped rather than ballooning the process.
const MAX_BACKLOG = 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = null;
    this.open = true;
    this.awaitingPong = false;

    this.onmessage = null;
    this.onclose = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._teardown());
    socket.on('error', () => this._teardown());
  }

  // --- reading -------------------------------------------------------------

  _onData(chunk) {
    if (!this.open) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME + 14) return this.close(1009); // message too big

    let frame;
    while (this.open && (frame = this._readFrame())) {
      this._handleFrame(frame);
    }
  }

  // Returns a frame, or null when more bytes are needed. Protocol violations
  // close the connection and return null.
  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) { this.close(1002); return null; } // no extensions negotiated

    const isControl = (opcode & 0x8) !== 0;
    if (isControl && (len > 125 || !fin)) { this.close(1002); return null; }

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(MAX_FRAME)) { this.close(1009); return null; }
      len = Number(big);
    }
    if (len > MAX_FRAME) { this.close(1009); return null; }

    // RFC 6455 §5.1: every client→server frame must be masked.
    if (!masked) { this.close(1002); return null; }
    if (buf.length < offset + 4) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + len) return null;

    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];

    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP_CLOSE:
        this.close(1000);
        return;
      case OP_PING:
        this._sendFrame(OP_PONG, payload);
        return;
      case OP_PONG:
        this.awaitingPong = false;
        return;
      case OP_TEXT:
      case OP_BIN:
        if (this.fragmentOp !== null) { this.close(1002); return; } // interleaved start
        if (fin) return this._deliver(opcode, payload);
        this.fragmentOp = opcode;
        this.fragments = [payload];
        return;
      case OP_CONT: {
        if (this.fragmentOp === null) { this.close(1002); return; } // continuation with no start
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, b) => n + b.length, 0);
        if (total > MAX_FRAME) { this.close(1009); return; }
        if (!fin) return;
        const op = this.fragmentOp;
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentOp = null;
        return this._deliver(op, full);
      }
      default:
        this.close(1002);
    }
  }

  _deliver(opcode, payload) {
    if (opcode !== OP_TEXT || !this.onmessage) return; // binary frames are unused
    try {
      this.onmessage(payload.toString('utf8'));
    } catch (err) {
      console.error('message handler threw:', err);
    }
  }

  // --- writing -------------------------------------------------------------

  _sendFrame(opcode, payload) {
    if (!this.open) return;
    if (this.socket.writableLength > MAX_BACKLOG) {
      // Slow consumer: drop it instead of buffering unboundedly. Don't go
      // through close(), which would try to write yet another frame.
      this._teardown();
      this.socket.destroy();
      return;
    }
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._teardown();
    }
  }

  send(str) { this._sendFrame(OP_TEXT, Buffer.from(str, 'utf8')); }

  ping() {
    this.awaitingPong = true;
    this._sendFrame(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.open) {
      const body = Buffer.allocUnsafe(2);
      body.writeUInt16BE(code, 0);
      this._sendFrame(OP_CLOSE, body);
    }
    this._teardown();
    this.socket.end();
  }

  _teardown() {
    if (!this.open) return;
    this.open = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    if (this.onclose) this.onclose();
  }
}

// Browsers always send an Origin header on WebSocket upgrades. Without this
// check, any web page a user visits can open ws://our-host from their browser
// and act with their network position (cross-site WebSocket hijacking).
// Non-browser clients (the test harness, curl-alikes) send no Origin and pass.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new WSConnection(socket);
}

// ===========================================================================
// 2. Store: the only place room state lives
// ===========================================================================

const MAX_TOPIC_LEN = 140;
const MAX_NAME_LEN = 24;
const MAX_MSG_LEN = 1000;
const MAX_HISTORY = 200;
const MAX_ROOMS = 200; // hard cap so room:create spam can't exhaust memory
const MAX_VOTER_ID_LEN = 40;
const MAX_BALLOTS = 5000; // per room; a ballot is tiny, but nothing is unbounded
const EMPTY_ROOM_TTL = 5 * 60 * 1000;

const store = (() => {
  const rooms = new Map(); // roomId -> room
  let nextMessageId = 1;

  const newRoomId = () => crypto.randomBytes(3).toString('hex');

  return {
    createRoom(topic) {
      let id;
      do { id = newRoomId(); } while (rooms.has(id));
      const room = {
        id,
        topic,
        createdAt: Date.now(),
        status: 'live', // 'live' | 'concluded'
        result: null,
        seats: { pro: null, con: null },
        debateMessages: [],
        audienceMessages: [],
        members: new Set(),
        // voterId -> { entry, current, seated }. Keyed by a browser-held id
        // rather than by connection, so a reconnect resumes the same ballot
        // instead of filing a second one with a post-persuasion "entry".
        ballots: new Map(),
        // The floor. index -1 means the format has not been started and the
        // stage is still a free-for-all, which is what a room is before anyone
        // calls it to order.
        turn: { index: -1, endsAt: 0, remainingMs: 0, paused: false, pausedReason: null, over: false },
        turnTimer: null,
        reapTimer: null,
      };
      rooms.set(id, room);
      return room;
    },

    getRoom(id) { return rooms.get(id) || null; },
    listRooms() { return [...rooms.values()]; },

    addMember(room, client) {
      room.members.add(client);
      if (room.reapTimer) { clearTimeout(room.reapTimer); room.reapTimer = null; }
    },

    removeMember(room, client) { room.members.delete(client); },

    takeSeat(room, side, client) {
      room.seats[side] = { clientId: client.id, name: client.name };
    },

    freeSeat(room, side) { room.seats[side] = null; },

    appendMessage(room, stream, msg) {
      const list = stream === 'debate' ? room.debateMessages : room.audienceMessages;
      msg.id = nextMessageId++;
      list.push(msg);
      while (list.length > MAX_HISTORY) list.shift();
      return msg;
    },

    // The first ballot filed under a voterId wins, permanently. Re-joining
    // cannot reset an entry stance. That would let anyone who was persuaded
    // erase the evidence by leaving and coming back.
    openBallot(room, voterId, entry) {
      const existing = room.ballots.get(voterId);
      if (existing) return existing;
      if (room.ballots.size >= MAX_BALLOTS) return null;
      const ballot = { entry, current: entry, seated: false };
      room.ballots.set(voterId, ballot);
      return ballot;
    },

    getBallot(room, voterId) { return room.ballots.get(voterId) || null; },
    listBallots(room) { return [...room.ballots.values()]; },

    conclude(room, result) {
      room.status = 'concluded';
      room.result = result;
      return room;
    },

    // Rooms linger for a grace period so a reconnecting host doesn't lose them.
    scheduleReap(room, onReap) {
      if (room.members.size > 0 || room.reapTimer) return;
      room.reapTimer = setTimeout(() => {
        room.reapTimer = null;
        if (rooms.get(room.id) !== room || room.members.size > 0) return;
        rooms.delete(room.id);
        onReap();
      }, EMPTY_ROOM_TTL);
      if (room.reapTimer.unref) room.reapTimer.unref();
    },
  };
})();

const clients = new Set(); // every live connection, in a room or in the lobby

// Control characters (C0/C1) and bidi/zero-width overrides have no place in
// names, topics, or single-line chat: they enable name spoofing (U+202E flips
// text direction) and log injection. Stripped before trim/truncate.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

// Strip, trim, then truncate. Empty-after-trim is the caller's problem to reject.
const clean = (value, max) =>
  String(value ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);

function roomSummary(room) {
  let audienceCount = 0;
  for (const c of room.members) if (c.role === 'audience') audienceCount++;
  return {
    id: room.id,
    topic: room.topic,
    createdAt: room.createdAt,
    status: room.status,
    proTaken: !!room.seats.pro,
    conTaken: !!room.seats.con,
    proName: room.seats.pro ? room.seats.pro.name : null,
    conName: room.seats.con ? room.seats.con.name : null,
    audienceCount,
  };
}

// The live gauge counts who is in the room RIGHT NOW, which is not the same
// population the verdict is drawn from. That one is every ballot ever filed,
// present or not (see `finalVerdict`). Two different questions: "where is the
// room leaning" and "who moved it".
//
// Only the audience is counted. A seated debater voting for their own side
// would be marking their own paper, so seats are skipped; their pick is kept
// so it comes back if they step down.
function leanTally(room) {
  let pro = 0;
  let con = 0;
  let undecided = 0;
  for (const c of room.members) {
    if (c.role !== 'audience') continue;
    if (c.lean === 'pro') pro++;
    else if (c.lean === 'con') con++;
    else undecided++;
  }
  return { pro, con, undecided };
}

// --- broadcast helpers -----------------------------------------------------

function sendTo(client, type, data) {
  client.ws.send(JSON.stringify({ type, data }));
}

function broadcastRoom(room, type, data, except) {
  const frame = JSON.stringify({ type, data });
  for (const c of room.members) if (c !== except) c.ws.send(frame);
}

function broadcastLobby() {
  const frame = JSON.stringify({
    type: 'lobby:rooms',
    // A concluded room is a record, not an invitation: it drops off the floor
    // and reappears under "settled" with a permalink.
    data: store.listRooms().filter((r) => r.status === 'live').map(roomSummary),
  });
  for (const c of clients) c.ws.send(frame);
}

function broadcastResults() {
  const frame = JSON.stringify({ type: 'lobby:results', data: archive.list() });
  for (const c of clients) c.ws.send(frame);
}

// Every mutation that changes a room summary must call this, or the lobby and
// the seat bar go stale (see README, pitfall #4).
function publishRoom(room) {
  broadcastRoom(room, 'room:state', roomSummary(room));
  broadcastRoom(room, 'room:lean', leanTally(room));
  broadcastLobby();
}

// ===========================================================================
// 3. Handlers
// ===========================================================================

// Detaches a client from its room, freeing its seat. Used by both the explicit
// leave and the disconnect path, so a closed tab can't leave a zombie seat.
function leaveRoom(client) {
  const room = client.room;
  if (!room) return;

  store.removeMember(room, client);
  // A settled debate keeps its seats: the record names who argued, and the
  // room's own header should not start contradicting the permalink the moment
  // the winner closes their tab.
  const wasSeated =
    room.status !== 'concluded' && (client.role === 'pro' || client.role === 'con');

  if (wasSeated) {
    store.freeSeat(room, client.role);
    // A debater walking out stops the clock rather than running it down for the
    // side still in the room. Losing your connection is not a concession.
    pauseTurn(room, `the ${client.role.toUpperCase()} seat is empty`);
    broadcastRoom(room, 'debate:system', {
      text: `${client.name} left the ${client.role.toUpperCase()} seat`,
      ts: Date.now(),
    });
    // The stage typing line would otherwise stick around forever.
    broadcastRoom(room, 'debate:typing', { name: client.name, role: client.role, isTyping: false });
  } else {
    broadcastRoom(room, 'audience:system', { text: `${client.name} left`, ts: Date.now() });
  }

  client.room = null;
  client.role = null;
  client.lean = null;

  publishRoom(room);
  store.scheduleReap(room, broadcastLobby);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------
// One timer per room rather than one interval scanning every room. A debate
// spends most of its life with nothing due, and a global tick would wake up
// hundreds of times a minute to discover exactly that.

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function armTurnTimer(room, ms) {
  clearTurnTimer(room);
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    // Re-check rather than trust the timer: the room may have been settled,
    // paused, or advanced by a pass between arming and firing.
    if (room.status === 'concluded' || room.turn.paused || room.turn.index < 0) return;
    const t = format.turnAt(room.turn.index);
    if (t) {
      broadcastRoom(room, 'debate:system', {
        text: `${t.side.toUpperCase()} is out of time`,
        ts: Date.now(),
      });
    }
    advanceTurn(room);
  }, Math.max(0, ms));
  if (room.turnTimer.unref) room.turnTimer.unref();
}

function publishTurn(room) {
  broadcastRoom(room, 'debate:turn', format.turnState(room));
}

function beginTurn(room, index) {
  const t = format.turnAt(index);
  if (!t) return endFormat(room);

  room.turn.index = index;
  room.turn.paused = false;
  room.turn.pausedReason = null;
  room.turn.remainingMs = t.seconds * 1000;
  room.turn.endsAt = Date.now() + room.turn.remainingMs;

  broadcastRoom(room, 'debate:system', {
    text: `${t.round}: ${t.side.toUpperCase()} has the floor`,
    ts: Date.now(),
  });
  // The floor changing hands clears any stale typing line from the side that
  // just lost it, which would otherwise sit there for its full five seconds.
  broadcastRoom(room, 'debate:typing', { name: '', role: t.side, isTyping: false });
  publishTurn(room);
  armTurnTimer(room, room.turn.remainingMs);
}

function advanceTurn(room) {
  clearTurnTimer(room);
  if (format.isLastTurn(room.turn.index)) return endFormat(room);
  beginTurn(room, room.turn.index + 1);
}

// The format running out settles the debate by itself. A debate that went the
// full distance should not also need somebody to remember to press a button.
function endFormat(room) {
  clearTurnTimer(room);
  room.turn.index = -1;
  room.turn.over = true;
  publishTurn(room);

  const settled = settleRoom(room, 'The format ran its course. The debate is settled.');
  if (settled.error) {
    // Nothing was written, so the room stays live and callable by hand. This is
    // reachable: a debater can walk out during the closing round, leaving a
    // seat empty and the transcript one-sided.
    broadcastRoom(room, 'debate:system', {
      text: `Format over, but it cannot be settled: ${settled.error}`,
      ts: Date.now(),
    });
  }
}

// Pausing rather than forfeiting. A dropped connection is not a concession, and
// the reconnect path already brings people back within seconds.
function pauseTurn(room, reason) {
  if (room.turn.index < 0 || room.turn.paused) return;
  clearTurnTimer(room);
  room.turn.remainingMs = Math.max(0, room.turn.endsAt - Date.now());
  room.turn.paused = true;
  room.turn.pausedReason = reason;
  broadcastRoom(room, 'debate:system', { text: `Clock stopped: ${reason}`, ts: Date.now() });
  publishTurn(room);
}

function resumeTurn(room) {
  if (room.turn.index < 0 || !room.turn.paused) return;
  if (!room.seats.pro || !room.seats.con) return; // still a seat short
  room.turn.paused = false;
  room.turn.pausedReason = null;
  room.turn.endsAt = Date.now() + room.turn.remainingMs;
  broadcastRoom(room, 'debate:system', { text: 'Clock running', ts: Date.now() });
  publishTurn(room);
  armTurnTimer(room, room.turn.remainingMs);
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------
// Shared by the button and by the clock, so a debate that ran its course and one
// that was called early produce byte-identical records.

function settleRoom(room, systemText) {
  if (room.status === 'concluded') return { error: 'Already settled.' };
  if (!room.seats.pro || !room.seats.con) {
    return { error: 'Both seats have to be filled before this counts.' };
  }
  // A verdict drawn from a one-sided transcript is not a verdict. Without this
  // a debater could open, post once, and bank a "win" against silence.
  const spoke = new Set(room.debateMessages.map((m) => m.role));
  if (!spoke.has('pro') || !spoke.has('con')) {
    return { error: 'Both sides need to make a case first.' };
  }

  const verdict = computeVerdict(store.listBallots(room));
  const record = {
    version: 1,
    id: room.id,
    topic: room.topic,
    createdAt: room.createdAt,
    concludedAt: Date.now(),
    pro: { name: room.seats.pro.name },
    con: { name: room.seats.con.name },
    verdict,
    // Written into the record rather than derived twice. The live result card
    // and the permalink must never describe the same debate differently, and
    // the surest way to guarantee that is for there to be one sentence.
    headline: verdictLine(verdict, room.seats.pro.name, room.seats.con.name),
    debateMessages: room.debateMessages,
    audienceMessages: room.audienceMessages,
  };

  // Archive first: if the write fails, the room stays live and callable rather
  // than ending in a state whose permalink 404s.
  try {
    archive.save(record);
  } catch (err) {
    console.error('archive failed:', err);
    return { error: 'Could not save the record. Nothing was lost. Try again.' };
  }

  clearTurnTimer(room);
  store.conclude(room, record);
  broadcastRoom(room, 'debate:system', { text: systemText, ts: record.concludedAt });
  broadcastRoom(room, 'room:concluded', { result: record, url: `/d/${room.id}` });
  publishRoom(room);
  broadcastResults();
  return { ok: true, result: record, url: `/d/${room.id}` };
}

const handlers = {
  'room:create'(client, { topic } = {}) {
    topic = clean(topic, MAX_TOPIC_LEN);
    if (!topic) return { error: 'Give it a topic first.' };
    if (store.listRooms().length >= MAX_ROOMS) {
      return { error: 'Too many live debates right now. Try again soon.' };
    }

    const room = store.createRoom(topic);
    // The creator hasn't joined yet. Without this, a room that never gets a
    // member has no reap path and leaks forever. Joining cancels the timer.
    store.scheduleReap(room, broadcastLobby);
    broadcastLobby();
    return { roomId: room.id };
  },

  // Everyone arrives as audience. Seats are always claimed explicitly.
  //
  // `stance` is the whole point of the join step now: it is recorded BEFORE the
  // history is replayed, so it is a reading of where this person stood before
  // they were exposed to the argument. Asking afterwards would measure nothing.
  'room:join'(client, { roomId, name, stance, voterId } = {}) {
    const room = store.getRoom(roomId);
    if (!room) return { error: 'That one is over.' };
    if (room.status === 'concluded') {
      return { error: 'That debate is settled.', resultUrl: `/d/${room.id}` };
    }

    if (client.room) leaveRoom(client);

    client.name = clean(name, MAX_NAME_LEN) || 'Guest';
    client.role = 'audience';
    client.room = room;

    // A client-supplied id is spoofable, and deliberately so: there are no
    // accounts here, so this buys ballot CONTINUITY across reconnects, not
    // ballot integrity. Stuffing is possible and out of scope. See the README.
    client.voterId = clean(voterId, MAX_VOTER_ID_LEN) || `anon-${client.id}`;
    const entry = stance === 'pro' || stance === 'con' ? stance : null;
    const ballot = store.openBallot(room, client.voterId, entry);
    client.lean = ballot ? ballot.current : null;
    store.addMember(room, client);

    broadcastRoom(room, 'audience:system',
      { text: `${client.name} joined the audience`, ts: Date.now() }, client);
    publishRoom(room);

    return {
      ok: true,
      room: roomSummary(room),
      role: 'audience',
      // Late joiners get both streams in full so nothing is missed.
      debateMessages: room.debateMessages,
      audienceMessages: room.audienceMessages,
      lean: leanTally(room),
      myLean: client.lean,
      // Echoed back so a returning voter sees their original stance, not the
      // one they just picked in a modal the server ignored.
      myEntry: ballot ? ballot.entry : null,
      // Late arrivals and reconnects need the clock, not just the history. The
      // remaining time is computed at send, so it is correct on arrival.
      turn: format.turnState(room),
    };
  },

  'room:leave'(client) {
    if (!client.room) return { error: 'You are not in a debate.' };
    leaveRoom(client);
    return { ok: true };
  },

  'seat:claim'(client, { side } = {}) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (room.status === 'concluded') return { error: 'This debate is settled.' };
    if (side !== 'pro' && side !== 'con') return { error: 'Pick PRO or CON.' };
    if (client.role !== 'audience') return { error: 'You are already seated.' };
    if (room.seats[side]) return { error: 'Someone beat you to it.' };

    store.takeSeat(room, side, client);
    client.role = side;

    // Struck from the panel for good, even if they step down later. You argued;
    // you do not also get to be evidence that the argument worked.
    const ballot = store.getBallot(room, client.voterId);
    if (ballot) ballot.seated = true;

    // A seat refilling restarts a clock that was stopped waiting for exactly
    // this. The replacement inherits whatever time was left, not a fresh turn.
    resumeTurn(room);

    broadcastRoom(room, 'debate:system', {
      text: `${client.name} takes the ${side.toUpperCase()} side`,
      ts: Date.now(),
    });
    publishRoom(room);
    return { ok: true, role: side };
  },

  'seat:release'(client) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (room.status === 'concluded') return { error: 'This debate is settled.' };
    if (client.role !== 'pro' && client.role !== 'con') return { error: 'You are not seated.' };

    const side = client.role;
    store.freeSeat(room, side);
    client.role = 'audience';
    pauseTurn(room, `the ${side.toUpperCase()} seat is empty`);

    broadcastRoom(room, 'debate:system', {
      text: `${client.name} left the ${side.toUpperCase()} seat`,
      ts: Date.now(),
    });
    broadcastRoom(room, 'debate:typing', { name: client.name, role: side, isTyping: false });
    publishRoom(room);
    return { ok: true, role: 'audience' };
  },

  // The stage belongs to the two seated debaters only.
  'debate:message'(client, { text } = {}) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (room.status === 'concluded') return { error: 'This debate is settled.' };
    if (client.role !== 'pro' && client.role !== 'con') {
      return { error: 'Take a seat if you want to argue.' };
    }
    // Before the room is called to order the stage is open, which is what the
    // app was entirely. Once a format is running the floor is the gate.
    if (room.turn.index >= 0) {
      if (room.turn.paused) return { error: 'The clock is stopped.' };
      const current = format.turnAt(room.turn.index);
      if (current && client.role !== current.side) {
        return { error: `${current.side.toUpperCase()} has the floor. Wait your turn.` };
      }
    }
    text = clean(text, MAX_MSG_LEN);
    if (!text) return { error: 'Say something first.' };

    const msg = store.appendMessage(room, 'debate',
      { role: client.role, name: client.name, text, ts: Date.now() });
    broadcastRoom(room, 'debate:message', msg);
    return { ok: true };
  },

  // The sidebar is open to everyone; the role tag lets the UI colour names.
  'audience:message'(client, { text } = {}) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (room.status === 'concluded') return { error: 'This debate is settled.' };
    text = clean(text, MAX_MSG_LEN);
    if (!text) return { error: 'Say something first.' };

    const msg = store.appendMessage(room, 'audience',
      { role: client.role, name: client.name, text, ts: Date.now() });
    broadcastRoom(room, 'audience:message', msg);
    return { ok: true };
  },

  // Neutral is the starting position, not a destination: this only accepts a
  // side, so there is no wire format for going back.
  'audience:lean'(client, { side } = {}) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (room.status === 'concluded') return { error: 'This debate is settled.' };
    if (side !== 'pro' && side !== 'con') return { error: 'Pick PRO or CON.' };
    if (client.lean === side) return { ok: true, lean: side };

    const flipped = client.lean !== null;
    client.lean = side;

    // The ballot is the durable copy: `client.lean` dies with the connection,
    // and a verdict that forgot everyone who closed a tab would be measuring
    // stamina rather than persuasion.
    const ballot = store.getBallot(room, client.voterId);
    if (ballot) ballot.current = side;

    // Only a flip gets announced. First picks would be a wall of noise at the
    // top of every debate, whereas someone changing their mind is the point.
    if (flipped) {
      broadcastRoom(room, 'audience:system', {
        text: `${client.name} flipped to ${side.toUpperCase()}`,
        ts: Date.now(),
      });
    }
    if (client.role === 'audience') broadcastRoom(room, 'room:lean', leanTally(room));
    return { ok: true, lean: side };
  },

  // Either debater can call it. Requiring both to agree would hand the loser a
  // veto, and a debate nobody can end is the state this app was already in.
  //
  // With a format running this is the early exit. The last turn ending settles
  // the debate on its own, so a full debate needs nobody to press anything.
  'debate:conclude'(client) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (client.role !== 'pro' && client.role !== 'con') {
      return { error: 'Only the two debaters can call it.' };
    }
    return settleRoom(room, `${client.name} called it. The debate is settled.`);
  },

  // Calling the room to order. Either debater can do it, and until one does the
  // stage stays open, which is what a room is before a debate starts: people
  // turning up, testing the mic, arguing loosely.
  'debate:start'(client) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (room.status === 'concluded') return { error: 'This debate is settled.' };
    if (client.role !== 'pro' && client.role !== 'con') {
      return { error: 'Only the two debaters can start it.' };
    }
    if (room.turn.index >= 0) return { error: 'Already under way.' };
    if (room.turn.over) return { error: 'The format has already run.' };
    if (!room.seats.pro || !room.seats.con) {
      return { error: 'Both seats have to be filled first.' };
    }

    broadcastRoom(room, 'debate:system', {
      text: `${client.name} called the room to order`,
      ts: Date.now(),
    });
    beginTurn(room, 0);
    return { ok: true, turn: format.turnState(room) };
  },

  // Yielding early. The clock would take the floor anyway, so this only ever
  // hands the other side more time than they were owed.
  'debate:pass'(client) {
    const room = client.room;
    if (!room) return { error: 'Join a debate first.' };
    if (room.status === 'concluded') return { error: 'This debate is settled.' };
    if (room.turn.index < 0) return { error: 'The debate has not started.' };
    if (room.turn.paused) return { error: 'The debate is paused.' };

    const current = format.turnAt(room.turn.index);
    if (!current || client.role !== current.side) {
      return { error: 'You do not have the floor.' };
    }
    broadcastRoom(room, 'debate:system', {
      text: `${client.name} yields the floor`,
      ts: Date.now(),
    });
    advanceTurn(room);
    return { ok: true };
  },

  'debate:typing'(client, { isTyping } = {}) {
    const room = client.room;
    if (!room || room.status === 'concluded') return { ok: true };
    if (client.role !== 'pro' && client.role !== 'con') return { ok: true };
    broadcastRoom(room, 'debate:typing',
      { name: client.name, role: client.role, isTyping: !!isTyping }, client);
    return { ok: true };
  },
};

// ===========================================================================
// 4. HTTP + wiring
// ===========================================================================

const PUBLIC_DIR = path.resolve(__dirname, 'public');

// The mothership. One server carries two sites: the bare domain serves the
// ComradeCoding homepage, every other host serves the app. Routed on the Host
// header because that is what actually distinguishes the two in production,
// where debate.comradecoding.com and the railway domain both point here.
// `/home` serves the same page on any host, so it works before DNS exists and
// gives the app a same-origin path to link back to.
const HOME_DIR = path.resolve(__dirname, 'homesite');
const HOME_HOSTS = new Set(
  (process.env.HOME_HOSTS || 'comradecoding.com,www.comradecoding.com')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
);
const hostOf = (req) => String(req.headers.host || '').toLowerCase().split(':')[0];
// Files belonging to the homepage rather than the app, served from the home
// root whatever host asked for them. Explicit rather than a fallback search,
// so a name colliding with an app asset can never quietly shadow it.
const HOME_ASSETS = new Set([
  '/midi.js', '/marx.gif', '/sickle.gif', '/trotsky.png', '/manifesto.gif',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// Shared by both HTML routes. `scriptSrc` is the only thing that differs: the
// live page has one inline block and needs 'unsafe-inline'; a result page is a
// static document, so it gets the stricter 'none'.
const securityHeaders = (scriptSrc) => ({
  'Cache-Control': 'no-cache',
  'Content-Security-Policy':
    `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; ` +
    "img-src 'self' data:; connect-src 'self' ws: wss:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
});

// Only used to build the absolute permalink printed on the page. Host is
// attacker-controlled, so it is validated to a hostname[:port] shape rather
// than interpolated raw. A Host header is not a trusted string.
const HOST_RE = /^[a-zA-Z0-9.\-]+(:\d{1,5})?$/;
function originOf(req) {
  const host = req.headers.host || '';
  if (!HOST_RE.test(host)) return '';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (urlPath.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }

  // --- the permalink -------------------------------------------------------
  // Never touches the static path at all. The id is matched against the exact
  // 6-hex-char room-id shape before it reaches the filesystem, so `..` and
  // friends are rejected as "no such debate" rather than defended against.
  if (urlPath.startsWith('/d/')) {
    const id = urlPath.slice(3);
    const record = archive.isValidId(id) ? archive.load(id) : null;
    if (!record) {
      res.writeHead(404, { ...securityHeaders("'none'"), 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><meta charset="utf-8"><title>No such debate</title>' +
        '<body style="background:#0a0b10;color:#f4f1e9;font:16px system-ui;padding:60px">' +
        'No debate lives at that address. <a style="color:#b96bff" href="/">Start one</a>.');
    }
    const body = resultpage.render(record, originOf(req));
    res.writeHead(200, {
      ...securityHeaders("'none'"),
      'Content-Type': 'text/html; charset=utf-8',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  // --- which site? ---------------------------------------------------------
  // The bare domain gets the homepage; `/home` gets it on any host. Permalinks
  // stay above this split, so an archived debate shares from either domain.
  let docRoot = PUBLIC_DIR;
  if (HOME_HOSTS.has(hostOf(req))) docRoot = HOME_DIR;

  // The homepage's own assets resolve from the home root on every host. The
  // page reaches other hosts by path, at /home, but its markup asks for
  // /midi.js at the root, and without this that request lands in the app's
  // root and 404s. The page then renders silent everywhere except the bare
  // domain, which is the one place nobody tests first.
  if (HOME_ASSETS.has(urlPath)) docRoot = HOME_DIR;

  if (urlPath === '/home' || urlPath === '/home/') {
    docRoot = HOME_DIR;
    urlPath = '/';
  }
  // The arena lives under the umbrella: comradecoding.com/arena is the app,
  // no subdomain required. The app is one self-contained file and its socket
  // connects by host alone, so it serves from any path unchanged.
  if (urlPath === '/arena' || urlPath === '/arena/') {
    docRoot = PUBLIC_DIR;
    urlPath = '/';
  }

  if (urlPath === '/') urlPath = '/index.html';

  // Resolve, then confirm we never escaped the chosen root. `..`, absolute
  // paths and sibling directories like `publicX` all fail this check.
  const filePath = path.resolve(docRoot, '.' + path.posix.normalize(urlPath));
  if (filePath !== docRoot && !filePath.startsWith(docRoot + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      // The homepage keeps its script in a file rather than inline, so it can
      // run under 'self' and still ban inline execution. Only the app page,
      // which is one document with its logic inside it, needs 'unsafe-inline'.
      ...securityHeaders(docRoot === HOME_DIR ? "'self'" : "'unsafe-inline'"),
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

let nextClientId = 1;

// Per-connection token bucket: enough for any real user, far too little for a
// broadcast-amplification flood. A client that keeps pushing after running dry
// is dropped outright.
const RATE_BURST = 20;
const RATE_REFILL_PER_SEC = 10;
const RATE_MAX_STRIKES = 200;

server.on('upgrade', (req, socket) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const ws = acceptUpgrade(req, socket);
  if (!ws) return;

    const client = {
    id: nextClientId++, ws, name: null, role: null, room: null, lean: null, voterId: null,
  };
  client.tokens = RATE_BURST;
  client.lastRefill = Date.now();
  client.strikes = 0;
  clients.add(client);
  sendTo(client, 'lobby:rooms',
    store.listRooms().filter((r) => r.status === 'live').map(roomSummary));
  sendTo(client, 'lobby:results', archive.list());

  ws.onmessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // Only echo ack ids a sane client would send; anything else (objects,
    // huge strings) is dropped rather than reflected back.
    const ackId =
      typeof msg.id === 'number' || (typeof msg.id === 'string' && msg.id.length <= 64)
        ? msg.id
        : null;

    const now = Date.now();
    client.tokens = Math.min(
      RATE_BURST,
      client.tokens + ((now - client.lastRefill) * RATE_REFILL_PER_SEC) / 1000
    );
    client.lastRefill = now;
    if (client.tokens < 1) {
      if (++client.strikes > RATE_MAX_STRIKES) return ws.close(1008); // policy violation
      if (ackId != null) ws.send(JSON.stringify({ ackId, data: { error: 'Slow down.' } }));
      return;
    }
    client.tokens -= 1;
    client.strikes = 0;

    // Own-property lookup only: `{"type":"constructor"}` must not dispatch
    // down the prototype chain.
    const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
    let result;
    if (!handler) {
      result = { error: `Unknown message type: ${msg.type}` };
    } else {
      // Handlers report failure as an ack payload; they never throw at the
      // client. An unexpected throw is a server bug, not a protocol error.
      try {
        result = handler(client, msg.data);
      } catch (err) {
        console.error(`handler ${msg.type} failed:`, err);
        result = { error: 'That broke on our end.' };
      }
    }
    if (ackId != null) ws.send(JSON.stringify({ ackId, data: result ?? { ok: true } }));
  };

  ws.onclose = () => {
    leaveRoom(client);
    clients.delete(client);
  };
});

// Heartbeat: ping every 30s and drop anything that missed the previous pong.
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.ws.open) {
      leaveRoom(client);
      clients.delete(client);
      continue;
    }
    if (client.ws.awaitingPong) {
      client.ws.close(1001); // triggers onclose → leaveRoom
      continue;
    }
    client.ws.ping();
  }
}, 30000);
if (heartbeat.unref) heartbeat.unref();

const restored = archive.boot();

server.listen(PORT, () => {
  console.log(`MasterDebater Live running at http://localhost:${PORT}`);
  console.log(`${restored} settled debate${restored === 1 ? '' : 's'} in the archive`);
});

module.exports = { server };
