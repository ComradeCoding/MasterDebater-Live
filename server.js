'use strict';
//
// MasterDebater Live — a real-time debate platform: two seated debaters on a
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
      // through close() — that would try to write yet another frame.
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
// 2. Store — the only place room state lives
// ===========================================================================

const MAX_TOPIC_LEN = 140;
const MAX_NAME_LEN = 24;
const MAX_MSG_LEN = 1000;
const MAX_HISTORY = 200;
const MAX_ROOMS = 200; // hard cap so room:create spam can't exhaust memory
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
        seats: { pro: null, con: null },
        debateMessages: [],
        audienceMessages: [],
        members: new Set(),
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
    proTaken: !!room.seats.pro,
    conTaken: !!room.seats.con,
    proName: room.seats.pro ? room.seats.pro.name : null,
    conName: room.seats.con ? room.seats.con.name : null,
    audienceCount,
  };
}

// Only the audience is counted. A seated debater voting for their own side
// would be marking their own paper, so seats are skipped; their pick is kept
// so it comes back if they step down.
function leanTally(room) {
  let pro = 0;
  let con = 0;
  for (const c of room.members) {
    if (c.role !== 'audience') continue;
    if (c.lean === 'pro') pro++;
    else if (c.lean === 'con') con++;
  }
  return { pro, con };
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
    data: store.listRooms().map(roomSummary),
  });
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
  const wasSeated = client.role === 'pro' || client.role === 'con';

  if (wasSeated) {
    store.freeSeat(room, client.role);
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

const handlers = {
  'room:create'(client, { topic } = {}) {
    topic = clean(topic, MAX_TOPIC_LEN);
    if (!topic) return { error: 'Give it a topic first.' };
    if (store.listRooms().length >= MAX_ROOMS) {
      return { error: 'Too many live debates right now. Try again soon.' };
    }

    const room = store.createRoom(topic);
    // The creator hasn't joined yet — without this, a room that never gets a
    // member has no reap path and leaks forever. Joining cancels the timer.
    store.scheduleReap(room, broadcastLobby);
    broadcastLobby();
    return { roomId: room.id };
  },

  // Everyone arrives as audience — seats are always claimed explicitly.
  'room:join'(client, { roomId, name } = {}) {
    const room = store.getRoom(roomId);
    if (!room) return { error: 'That one is over.' };

    if (client.room) leaveRoom(client);

    client.name = clean(name, MAX_NAME_LEN) || 'Guest';
    client.role = 'audience';
    client.room = room;
    client.lean = null;
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
      myLean: null,
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
    if (side !== 'pro' && side !== 'con') return { error: 'Pick PRO or CON.' };
    if (client.role !== 'audience') return { error: 'You are already seated.' };
    if (room.seats[side]) return { error: 'Someone beat you to it.' };

    store.takeSeat(room, side, client);
    client.role = side;

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
    if (client.role !== 'pro' && client.role !== 'con') return { error: 'You are not seated.' };

    const side = client.role;
    store.freeSeat(room, side);
    client.role = 'audience';

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
    if (client.role !== 'pro' && client.role !== 'con') {
      return { error: 'Take a seat if you want to argue.' };
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
    if (side !== 'pro' && side !== 'con') return { error: 'Pick PRO or CON.' };
    if (client.lean === side) return { ok: true, lean: side };

    const flipped = client.lean !== null;
    client.lean = side;

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

  'debate:typing'(client, { isTyping } = {}) {
    const room = client.room;
    if (!room || (client.role !== 'pro' && client.role !== 'con')) return { ok: true };
    broadcastRoom(room, 'debate:typing',
      { name: client.name, role: client.role, isTyping: !!isTyping }, client);
    return { ok: true };
  },
};

// ===========================================================================
// 4. HTTP + wiring
// ===========================================================================

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

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
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve, then confirm we never escaped public/ — `..`, absolute paths and
  // sibling directories like `publicX` all fail this check.
  const filePath = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(urlPath));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // The page uses one inline script/style block, so 'unsafe-inline' has to
      // stay — the CSP still blocks external script injection and framing.
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self' ws: wss:; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
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

  const client = { id: nextClientId++, ws, name: null, role: null, room: null, lean: null };
  client.tokens = RATE_BURST;
  client.lastRefill = Date.now();
  client.strikes = 0;
  clients.add(client);
  sendTo(client, 'lobby:rooms', store.listRooms().map(roomSummary));

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

server.listen(PORT, () => {
  console.log(`MasterDebater Live running at http://localhost:${PORT}`);
});

module.exports = { server };
