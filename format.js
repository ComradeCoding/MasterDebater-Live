'use strict';
//
// The format: rounds, turns, and who holds the floor.
//
// Without this the stage is a free-for-all, which is an argument rather than a
// debate. Both sides type at once, the loud one wins on volume, and there is no
// shape to what the audience is being asked to judge.
//
// A turn is a WINDOW, not a single message. You hold the floor for a stretch
// and can post as many times as you like inside it, then yield or let the clock
// take it. Anything stricter fights the medium: this is a chat box, and one
// message per turn would force people to write a paragraph in an input that is
// one line tall.
//
// Pure data and pure functions. The running clock lives in server.js, because
// timers are state and this file has none.

// PRO speaks first in every round. The side proposing the motion carries the
// burden of proof, so it leads and CON always answers, which is also why the
// last word in each round belongs to CON.
const ROUNDS = [
  { name: 'Opening', seconds: 180 },
  { name: 'Rebuttal', seconds: 120 },
  { name: 'Closing', seconds: 90 },
];

// Test seam. Six turns at real length is thirteen minutes, which no test suite
// should sit through, so the whole schedule can be collapsed to a few seconds.
const OVERRIDE = Number(process.env.DEBATE_TURN_SECONDS) || 0;

function buildTurns() {
  const turns = [];
  for (const round of ROUNDS) {
    for (const side of ['pro', 'con']) {
      turns.push({ round: round.name, side, seconds: OVERRIDE || round.seconds });
    }
  }
  return turns;
}

const TURNS = buildTurns();

const turnAt = (index) => TURNS[index] || null;
const turnCount = () => TURNS.length;
const isLastTurn = (index) => index >= TURNS.length - 1;

// What the client needs to draw the turn bar. `remainingMs` rather than an
// absolute deadline: the client would otherwise be differencing its own clock
// against the server's, and the two disagree by however far the viewer's
// machine has drifted. The server stays authoritative for actual advancement,
// so a slightly wrong countdown is cosmetic.
function turnState(room, now = Date.now()) {
  if (!room.turn || room.turn.index < 0) {
    return { started: false, over: room.turn ? room.turn.over : false };
  }
  const t = turnAt(room.turn.index);
  if (!t) return { started: false, over: true };
  return {
    started: true,
    over: false,
    index: room.turn.index,
    total: TURNS.length,
    round: t.round,
    side: t.side,
    seconds: t.seconds,
    remainingMs: room.turn.paused
      ? room.turn.remainingMs
      : Math.max(0, room.turn.endsAt - now),
    paused: room.turn.paused,
    pausedReason: room.turn.pausedReason || null,
  };
}

module.exports = { ROUNDS, TURNS, turnAt, turnCount, isLastTurn, turnState };
