'use strict';
//
// The live store's durable copy: SQLite, through Node's built-in `node:sqlite`.
//
// Memory is still the working copy. Every handler reads room state on every
// message, and the room holds things no database can (open sockets, timers),
// so the store keeps its objects and writes each change through to here as
// it makes it. The database is what a restart reads back. Nothing is ever
// read from it while the server is running.
//
// The JSON archive is untouched. A settled debate is a record with a permanent
// URL, and a folder of JSON files anyone can read is the right shape for that.
// This file holds the opposite: state that is only interesting while it is
// still live, and is deleted the moment a debate settles.
//
// Every write is wrapped. A failed write is logged and the live room carries
// on, because a debate should not stop mid-sentence because a disk filled up;
// what is lost is only the ability to survive the next restart.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  turn        TEXT NOT NULL,
  pinned_question_id INTEGER
);
CREATE TABLE IF NOT EXISTS seats (
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  side     TEXT NOT NULL,
  name     TEXT NOT NULL,
  handle   TEXT,
  voter_id TEXT,
  PRIMARY KEY (room_id, side)
);
CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY,
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  stream   TEXT NOT NULL,
  role     TEXT NOT NULL,
  name     TEXT NOT NULL,
  text     TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room ON messages (room_id, stream, id);
CREATE TABLE IF NOT EXISTS ballots (
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  entry    TEXT,
  current  TEXT,
  seated   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, voter_id)
);
CREATE TABLE IF NOT EXISTS questions (
  id       INTEGER PRIMARY KEY,
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  text     TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  voter_id    TEXT NOT NULL,
  PRIMARY KEY (question_id, voter_id)
);
CREATE TABLE IF NOT EXISTS challenges (
  id         TEXT PRIMARY KEY,
  motion     TEXT NOT NULL,
  side       TEXT NOT NULL,
  name       TEXT NOT NULL,
  key        TEXT NOT NULL,
  handle     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handles (
  handle      TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open(dir) {
  let db;
  let file = ':memory:';
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'live.sqlite');
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
  } catch (err) {
    // An unwritable volume should not stop the app serving debates. It runs
    // exactly as it did before there was a database: nothing survives a restart.
    console.error(`live store unavailable at ${file}, keeping it in memory:`, err.message);
    file = ':memory:';
    db = new DatabaseSync(':memory:');
  }
  // NORMAL under WAL loses at most the last moment of writes to a power cut,
  // never consistency, and it keeps a chat message from waiting on fsync.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const st = {
    roomInsert: q('INSERT OR REPLACE INTO rooms (id, topic, created_at, turn, pinned_question_id) VALUES (?, ?, ?, ?, NULL)'),
    roomTurn: q('UPDATE rooms SET turn = ? WHERE id = ?'),
    roomPin: q('UPDATE rooms SET pinned_question_id = ? WHERE id = ?'),
    roomDelete: q('DELETE FROM rooms WHERE id = ?'),
    seatPut: q('INSERT OR REPLACE INTO seats (room_id, side, name, handle, voter_id) VALUES (?, ?, ?, ?, ?)'),
    seatDelete: q('DELETE FROM seats WHERE room_id = ? AND side = ?'),
    messageInsert: q('INSERT INTO messages (id, room_id, stream, role, name, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    messageTrim: q(`DELETE FROM messages WHERE room_id = ? AND stream = ? AND id NOT IN
      (SELECT id FROM messages WHERE room_id = ? AND stream = ? ORDER BY id DESC LIMIT ?)`),
    ballotInsert: q('INSERT OR IGNORE INTO ballots (room_id, voter_id, entry, current, seated) VALUES (?, ?, ?, ?, ?)'),
    ballotCurrent: q('UPDATE ballots SET current = ? WHERE room_id = ? AND voter_id = ?'),
    ballotSeated: q('UPDATE ballots SET seated = 1 WHERE room_id = ? AND voter_id = ?'),
    questionInsert: q('INSERT INTO questions (id, room_id, voter_id, name, text, ts) VALUES (?, ?, ?, ?, ?, ?)'),
    voteInsert: q('INSERT OR IGNORE INTO votes (question_id, voter_id) VALUES (?, ?)'),
    challengeInsert: q(`INSERT OR REPLACE INTO challenges (id, motion, side, name, key, handle, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    challengeDelete: q('DELETE FROM challenges WHERE id = ?'),
    handleGet: q('SELECT handle, secret_hash, created_at FROM handles WHERE handle = ?'),
    handleInsert: q('INSERT OR IGNORE INTO handles (handle, secret_hash, created_at) VALUES (?, ?, ?)'),
    metaSet: q('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
    metaGet: q('SELECT value FROM meta WHERE key = ?'),
  };

  // A write that fails is logged, never thrown into a handler.
  const write = (name, fn) => {
    try {
      return fn();
    } catch (err) {
      console.error(`live store write failed (${name}):`, err.message);
      return null;
    }
  };

  return {
    file,

    saveRoom(room) {
      write('room', () => st.roomInsert.run(room.id, room.topic, room.createdAt, JSON.stringify(room.turn)));
    },
    saveTurn(room) {
      write('turn', () => st.roomTurn.run(JSON.stringify(room.turn), room.id));
    },
    savePin(room) {
      write('pin', () => st.roomPin.run(room.pinnedQuestionId, room.id));
    },
    deleteRoom(id) {
      write('delete', () => st.roomDelete.run(id));
    },
    saveSeat(roomId, side, seat) {
      write('seat', () => (seat
        ? st.seatPut.run(roomId, side, seat.name, seat.handle || null, seat.voterId || null)
        : st.seatDelete.run(roomId, side)));
    },
    saveMessage(roomId, stream, msg, keep) {
      write('message', () => {
        st.messageInsert.run(msg.id, roomId, stream, msg.role, msg.name, msg.text, msg.ts);
        st.messageTrim.run(roomId, stream, roomId, stream, keep);
      });
    },
    saveBallot(roomId, voterId, b) {
      write('ballot', () => st.ballotInsert.run(roomId, voterId, b.entry, b.current, b.seated ? 1 : 0));
    },
    saveLean(roomId, voterId, current) {
      write('lean', () => st.ballotCurrent.run(current, roomId, voterId));
    },
    saveSeated(roomId, voterId) {
      write('seated', () => st.ballotSeated.run(roomId, voterId));
    },
    saveQuestion(roomId, qn) {
      write('question', () => st.questionInsert.run(qn.id, roomId, qn.voterId, qn.name, qn.text, qn.ts));
    },
    saveVote(questionId, voterId) {
      write('vote', () => st.voteInsert.run(questionId, voterId));
    },
    saveChallenge(ch) {
      write('challenge', () => st.challengeInsert.run(
        ch.id, ch.motion, ch.side, ch.name, ch.key, ch.handle || null, ch.createdAt, ch.expiresAt));
    },
    deleteChallenge(id) {
      write('challenge delete', () => st.challengeDelete.run(id));
    },
    getHandle(handle) {
      const row = write('handle read', () => st.handleGet.get(handle));
      return row
        ? { handle: row.handle, secretHash: Buffer.from(row.secret_hash), createdAt: row.created_at }
        : null;
    },
    saveHandle(h) {
      write('handle', () => st.handleInsert.run(h.handle, h.secretHash, h.createdAt));
    },
    setMeta(key, value) {
      write('meta', () => st.metaSet.run(key, String(value)));
    },
    getMeta(key) {
      const row = write('meta read', () => st.metaGet.get(key));
      return row ? row.value : null;
    },

    // Everything a restart needs, read once at boot.
    loadAll() {
      const all = (sql) => db.prepare(sql).all();
      return {
        rooms: all('SELECT * FROM rooms ORDER BY created_at'),
        seats: all('SELECT * FROM seats'),
        messages: all('SELECT * FROM messages ORDER BY id'),
        ballots: all('SELECT * FROM ballots'),
        questions: all('SELECT * FROM questions ORDER BY id'),
        votes: all('SELECT * FROM votes'),
        challenges: all('SELECT * FROM challenges ORDER BY created_at'),
        maxId: Math.max(
          db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages').get().n,
          db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM questions').get().n,
          Number(this.getMeta('next_id') || 1) - 1,
        ),
      };
    },

    close() {
      try { db.close(); } catch {}
    },
  };
}

module.exports = { open };
