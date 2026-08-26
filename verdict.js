'use strict';
//
// Verdict math: who moved the room.
//
// The live gauge answers "which side has more fans", which is the least
// interesting number in a debate: it mostly measures who showed up. This file
// answers the question the format is actually for: who changed minds.
//
// Every audience member records an ENTRY stance when they join, before they
// have read a word of the argument, and their CURRENT stance is whatever they
// last flipped to. The distance between those two tallies is the result.
//
// Pure functions only: no state, no I/O. A ballot is
//   { entry: 'pro'|'con'|null, current: 'pro'|'con'|null, seated: boolean }
// where null is undecided, and `seated` marks someone who took a seat and
// argued. They are struck from the panel rather than marking their own paper.

// The margin is measured in people, not in percent. Percentages of a 7-person
// audience are theatre; "+3" is a number nobody can misread.
function tallyOf(ballots, field) {
  let pro = 0;
  let con = 0;
  let undecided = 0;
  for (const b of ballots) {
    if (b[field] === 'pro') pro++;
    else if (b[field] === 'con') con++;
    else undecided++;
  }
  return { pro, con, undecided };
}

// Winner is decided by MARGIN SWING, not by head-count of converts, and the
// difference matters. Taking someone off your opponent's bench moves the margin
// by two; picking up an undecided moves it by one. That asymmetry is real,
// because converting a committed opponent is the harder act of persuasion, and
// it is the reason head-count and margin can disagree. Reporting both and letting
// them contradict each other would read as a bug, so margin is the verdict and
// the conversion counts are supporting detail.
function computeVerdict(ballots) {
  const panel = ballots.filter((b) => !b.seated);
  const open = tallyOf(panel, 'entry');
  const close = tallyOf(panel, 'current');
  const swing = (close.pro - close.con) - (open.pro - open.con);

  let toPro = 0;
  let toCon = 0;
  let crossed = 0;
  let held = 0;
  for (const b of panel) {
    if (b.current === b.entry) { held++; continue; }
    if (b.current === 'pro') {
      toPro++;
      if (b.entry === 'con') crossed++;
    } else if (b.current === 'con') {
      toCon++;
      if (b.entry === 'pro') crossed++;
    } else {
      // Unreachable: `audience:lean` accepts only 'pro' or 'con', so there is
      // no wire format for returning to the fence. Counted as held rather than
      // silently dropped, so the panel always adds up.
      held++;
    }
  }

  return {
    panel: panel.length,
    open,
    close,
    swing,
    winner: swing > 0 ? 'pro' : swing < 0 ? 'con' : 'draw',
    moved: { toPro, toCon, crossed, held },
  };
}

// One sentence, shared by the live result card and the permalink page so the
// two can never describe the same debate differently.
function verdictLine(v, proName, conName) {
  if (!v || !v.panel) return 'Nobody was watching. No verdict.';
  if (v.winner === 'draw') {
    return v.moved.toPro + v.moved.toCon > 0
      ? 'Both sides won people over. It came out level.'
      : 'Nobody moved. The room ended where it started.';
  }
  const who = (v.winner === 'pro' ? proName : conName) || v.winner.toUpperCase();
  const n = Math.abs(v.swing);
  return `${who} moved the room by ${n}.`;
}

module.exports = { tallyOf, computeVerdict, verdictLine };
