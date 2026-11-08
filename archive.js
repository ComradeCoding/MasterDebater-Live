'use strict';
//
// Archive: the permanent record of every settled debate.
//
// Live rooms survive a restart through the SQLite store (db.js), but only
// until they settle; they are reaped when they go empty and their rows are
// deleted when they conclude. A CONCLUDED debate is the opposite. It is a
// record, it gets a permanent URL, and it is the only thing anyone can share,
// so it has to outlive everything else here.
//
// One JSON file per debate under `data/`, not a table, because the access
// pattern is write-once/read-by-id, which is the shape a filesystem already
// is, and because a folder of JSON is a record anyone can read without the
// app. The live database sits in the same directory.

const fs = require('fs');
const path = require('path');

const DIR = process.env.ARCHIVE_DIR || path.resolve(__dirname, 'data');
// Room ids are `crypto.randomBytes(3).toString('hex')`. Anything reaching this
// module from a URL is checked against that shape BEFORE it touches a path.
// This regex is the whole path-traversal defence for /d/<id>.
const ID_RE = /^[0-9a-f]{6}$/;
// Only the lobby list is bounded. Files are never deleted: an archive that
// quietly drops old debates would break exactly the permalinks it exists to
// keep. Disk grows without limit by design. See the README.
const MAX_INDEX = 200;

let index = []; // newest first; lobby-sized summaries only
// Every record a handle argued, uncapped and oldest first. A debater's page
// that quietly dropped their early debates would be a worse lie than the
// lobby forgetting them, so this one indexes the whole archive.
const byHandle = new Map();

function indexHandles(summary) {
  for (const h of [summary.proHandle, summary.conHandle]) {
    if (!h) continue;
    const list = byHandle.get(h) || [];
    if (!list.some((r) => r.id === summary.id)) list.push(summary);
    list.sort((a, b) => a.concludedAt - b.concludedAt);
    byHandle.set(h, list);
  }
}

const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);
const fileFor = (id) => path.join(DIR, `${id}.json`);

function summarize(record) {
  return {
    id: record.id,
    topic: record.topic,
    concludedAt: record.concludedAt,
    winner: record.verdict.winner,
    swing: record.verdict.swing,
    panel: record.verdict.panel,
    // Floor-crossings, for the archive's "most contested" sort: two debates
    // that both ended level are not equally close if one of them had half the
    // room changing sides on the way there.
    crossed: (record.verdict.moved && record.verdict.moved.crossed) | 0,
    proName: record.pro.name,
    conName: record.con.name,
    proHandle: record.pro.handle || null,
    conHandle: record.con.handle || null,
  };
}

// Write to a temp file and rename, so a crash mid-write leaves the previous
// state rather than a half-written record that `load` would throw on.
function save(record) {
  if (!isValidId(record.id)) throw new Error(`refusing to archive bad id: ${record.id}`);
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${fileFor(record.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, fileFor(record.id));

  const summary = summarize(record);
  index = [summary, ...index.filter((r) => r.id !== record.id)];
  indexHandles(summary);
  if (index.length > MAX_INDEX) index.length = MAX_INDEX;
  return record;
}

function load(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  } catch {
    return null; // missing or corrupt reads as "no such debate"
  }
}

function list(limit = 50) {
  return index.slice(0, limit);
}

function forHandle(handle) {
  return (byHandle.get(handle) || []).slice();
}

// Rebuild the lobby index at boot. A corrupt file is skipped, never fatal:
// one bad record must not stop the server from starting.
function boot() {
  let names;
  try {
    names = fs.readdirSync(DIR);
  } catch {
    index = [];
    byHandle.clear();
    return 0; // no archive yet
  }

  const found = [];
  byHandle.clear();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = load(name.slice(0, -5));
    if (record && record.id && record.verdict && record.pro && record.con) {
      const summary = summarize(record);
      found.push(summary);
      indexHandles(summary);
    }
  }
  found.sort((a, b) => b.concludedAt - a.concludedAt);
  index = found.slice(0, MAX_INDEX);
  return index.length;
}

module.exports = { DIR, MAX_INDEX, isValidId, save, load, list, forHandle, boot };
