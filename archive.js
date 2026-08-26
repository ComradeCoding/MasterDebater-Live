'use strict';
//
// Archive: the only part of this app that survives a restart.
//
// Live rooms are deliberately ephemeral: they are reaped five minutes after
// going empty and nothing is written down. A CONCLUDED debate is the opposite.
// It is a record, it gets a permanent URL, and it is the only thing anyone can
// share, so it has to outlive the process that produced it.
//
// One JSON file per debate under `data/`. No database, because there is no npm
// here and because the access pattern is write-once/read-by-id, which is the
// shape a filesystem already is. Section 2 of server.js is still the swap point if that
// ever stops being true.

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
    proName: record.pro.name,
    conName: record.con.name,
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

  index = [summarize(record), ...index.filter((r) => r.id !== record.id)];
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

// Rebuild the lobby index at boot. A corrupt file is skipped, never fatal:
// one bad record must not stop the server from starting.
function boot() {
  let names;
  try {
    names = fs.readdirSync(DIR);
  } catch {
    index = [];
    return 0; // no archive yet
  }

  const found = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = load(name.slice(0, -5));
    if (record && record.id && record.verdict && record.pro && record.con) {
      found.push(summarize(record));
    }
  }
  found.sort((a, b) => b.concludedAt - a.concludedAt);
  index = found.slice(0, MAX_INDEX);
  return index.length;
}

module.exports = { DIR, isValidId, save, load, list, boot };
