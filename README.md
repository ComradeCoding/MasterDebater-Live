# MasterDebater Live

A real-time debate platform shaped like a boxing ring with a crowd. Two debaters
claim the **PRO** and **CON** seats and argue on a central stage; an unlimited
audience watches and talks in its own sidebar chat. Everything is live over
WebSockets.

The audience records where it stands on the way in, before reading a word. When
a debate is called, the difference between that opening reading and the closing
one is the result, and it gets a permanent page.

```
node server.js      →  http://localhost:3000
```

Node 18+ runs the server. Node 22+ is needed for `test-clients.js`, which uses
the built-in global `WebSocket` client.

> On this machine `node` is not on `PATH`. The only Node 22 binary present ships
> with Photoshop, so the commands below work as-is:
>
> ```bash
> "C:\Program Files\Adobe\Adobe Photoshop 2026\node.exe" server.js
> ```

## Zero dependencies

There is no `npm install` and no build step. The server is built-in `http` plus
a hand-rolled RFC 6455 WebSocket implementation; the client is one static HTML
file. Socket.IO would have been the default choice, but npm is unavailable in
this environment, so the spec's sanctioned zero-dependency fallback is what is
implemented here.

## Layout

```
debate-live/
  server.js           # static serving + WebSocket + all room/chat logic
  verdict.js          # verdict math, pure functions
  archive.js          # concluded debates on disk
  resultpage.js       # the permalink page, server-rendered
  public/index.html   # the entire frontend, markup, CSS and JS
  test-clients.js     # protocol-level end-to-end tests
  data/               # archived debates, one JSON file each (gitignored)
```

Three modules sit outside `server.js` because a concluded debate outlives the
process and a live room does not. Everything in `server.js` is about the live
room; the other three are about the record it leaves behind.

## Architecture

`server.js` is four sections, top to bottom:

1. **WebSocket transport.** `WSConnection`: handshake (SHA-1 of
   `Sec-WebSocket-Key` plus the RFC GUID), masked-frame parsing including the
   126 and 127 length forms, fragmentation via continuation frames, ping/pong,
   close handshake, and a 64 KB frame cap. Unmasked client frames, reserved
   bits, and oversized or malformed control frames close the connection.
2. **Store.** Every `Map` and array lives here behind a small API
   (`createRoom`, `addMember`, `takeSeat`, `appendMessage`, `openBallot`, ...).
   Handlers never touch the `Map` directly.
3. **Handlers.** One function per message type. They validate, mutate the store,
   and broadcast. They return an ack payload; failure is `{ error: "…" }`, never
   a thrown exception.
4. **HTTP + wiring.** Static file serving with a path-traversal guard, the
   `/d/<id>` permalink route, the upgrade handler, and a 30-second heartbeat.

Live room state is in memory, so restarting the server clears every room in
progress. Concluded debates are on disk and survive.

### Data model

```js
Room {
  id,              // 6 hex chars
  topic,
  createdAt,
  status,          // 'live' | 'concluded'
  result,          // the archived record, once concluded
  seats: { pro: { clientId, name } | null,
           con: { clientId, name } | null },
  debateMessages: [ { id, role, name, text, ts } ],
  audienceMessages: [ … ],
  members: Set<Client>,
  ballots: Map<voterId, { entry, current, seated }>,
}
```

Server-enforced limits: topic ≤ 140 chars, name ≤ 24, message ≤ 1000, 200
messages of history per stream per room (oldest dropped), 5000 ballots per room.
All input is trimmed; empty-after-trim is rejected. Live rooms are deleted five
minutes after going empty, with the emptiness re-checked when the timer fires.

## Protocol

Client to server: `{ id?, type, data }`. When `id` is present the server replies
`{ ackId: id, data: <result> }`.

| Type | Data | Ack |
| --- | --- | --- |
| `room:create` | `{ topic }` | `{ roomId }` |
| `room:join` | `{ roomId, name, stance, voterId }` | `{ ok, room, role, debateMessages, audienceMessages, lean, myLean, myEntry }` |
| `room:leave` | none | `{ ok }` |
| `seat:claim` | `{ side: 'pro' \| 'con' }` | `{ ok, role }` |
| `seat:release` | none | `{ ok, role: 'audience' }` |
| `debate:message` | `{ text }` | `{ ok }`, seated debaters only |
| `audience:message` | `{ text }` | `{ ok }`, anyone in the room |
| `audience:lean` | `{ side: 'pro' \| 'con' }` | `{ ok, lean }`, no neutral value exists |
| `debate:conclude` | none | `{ ok, result, url }`, seated debaters only |
| `debate:typing` | `{ isTyping }` | `{ ok }`, relayed from debaters only |

Server pushes: `lobby:rooms` (live room summaries), `lobby:results` (settled
debates), `room:state` (one summary), `debate:message`, `audience:message`,
`debate:system`, `audience:system`, `debate:typing` `{ name, role, isTyping }`,
`room:lean` `{ pro, con, undecided }`, and `room:concluded` `{ result, url }`.

Room summary: `{ id, topic, createdAt, status, proTaken, conTaken, proName,
conName, audienceCount }`.

Joining always lands you in the audience. Seats are only ever claimed
explicitly, including after a reconnect.

`audience:lean` moves you onto a side, and you can keep swapping between the two
for as long as the debate runs, but there is no message that puts you back on
the fence: the handler only accepts `'pro'` or `'con'`, so neutral is
unreachable by construction rather than by a client-side rule.

## The verdict

The live gauge answers "which side has more fans", which is mostly a measure of
who showed up. The verdict answers the question the format is actually for: who
changed minds.

Every audience member gives an **entry stance** in the join modal, before any
history is replayed to them. Asking afterwards would measure nothing. Their
**current stance** is whatever they last flipped to. A ballot is
`{ entry, current, seated }`, and the panel is every ballot in the room that is
not marked `seated`.

Anyone who takes a seat is struck from the panel permanently, even if they step
down later. You argued, so you do not also get to be evidence that the argument
worked.

The result is the shift in margin:

```
swing = (close.pro - close.con) - (open.pro - open.con)
```

Positive means PRO moved the room, negative means CON, zero is a draw.

**Margin, not head-count, decides it, and the distinction is load-bearing.**
Taking someone off your opponent's bench moves the margin by two; picking up an
undecided moves it by one. That asymmetry is real, because converting a
committed opponent is the harder act of persuasion. It also means the two
measures can disagree: a side can convert more heads and still lose on margin.
Reporting both as co-equal would read as a bug, so margin is the verdict and the
conversion counts are printed underneath as detail.

The headline sentence is written once, on the server, and stored in the record.
The live result card and the permalink both display that string rather than
deriving their own, so the two can never word the same result differently.

### Who counts

Ballots outlive connections. Someone who is persuaded and then closes their tab
still counts, because a verdict that forgot them would be measuring stamina
rather than persuasion. Ballots are keyed by a `voterId` the browser generates
and keeps in `localStorage`, which means a reconnect resumes the same ballot
instead of filing a second one with a post-persuasion "entry". The first ballot
filed under a `voterId` wins permanently; re-joining cannot rewrite it.

That id is client-supplied and trivially forgeable. It buys ballot continuity,
not ballot integrity. Stuffing is possible and out of scope until there are
accounts. One browser profile is one ballot, which is also why testing the
verdict across several tabs of the same browser needs the id overridden.

## Concluding

Either seated debater can call it. Requiring both to agree would hand the losing
side a veto, and a debate nobody can end is the state this app was already in.

Four things are checked first: the caller is seated, the debate is not already
settled, both seats are filled, and both sides have posted at least once.
Without the last check a debater could open, post once, and bank a win against
silence.

Concluding archives the record, then freezes the room. The stage, the sidebar,
the vote and the seats all start refusing writes, and the composers are replaced
by the result card rather than left on screen offering actions the server would
reject. The room drops off the live floor in the lobby and reappears under
"settled" with a link.

The write happens before the state change, so a failed write leaves the debate
live and callable rather than ending it in a state whose permalink 404s.

## The permalink

`/d/<id>` serves a concluded debate as a static document: motion, both debaters,
the swing figure, the opening and closing bars on one scale, the full transcript
with elapsed times, and the audience chat. It is the only page anyone outside
the room ever sees, so it carries the OpenGraph tags too.

It runs no JavaScript, so it is served under `script-src 'none'`, which is
strictly tighter than the live page's `'unsafe-inline'`. The id is matched
against the exact six-hex-char room-id shape before it reaches the filesystem,
so traversal attempts come back as "no such debate" rather than being defended
against further down.

Archived records store raw text exactly as the live server does. Every name,
topic and message is escaped by `resultpage.js` at render time.

Files are never deleted. An archive that quietly dropped old debates would break
exactly the permalinks it exists to keep, so disk grows without limit by design.
Only the in-memory lobby index is capped, at 200.

## Design notes

A few behaviours exist specifically to avoid bugs that showed up in the
prototype:

- **Seat-claim race.** `room:state` is broadcast before the caller's ack
  resolves, so the client's role-dependent UI would render against a stale role.
  The client sets `myRole` from the ack and then calls `renderRoom()` explicitly.
- **Escaping.** The server stores raw text. Every name, topic, and message is
  escaped at render time, on the live page and on the permalink both. Nothing
  user-supplied reaches `innerHTML` unescaped.
- **Zombie seats.** Leaving and disconnecting share one `leaveRoom()` path, so a
  closed tab frees its seat exactly like the Leave button does. A settled room is
  the exception: it keeps its seats, so the room header cannot start
  contradicting the permalink once the winner closes their tab.
- **Lobby staleness.** Every summary-changing mutation goes through
  `publishRoom()`, which sends both `room:state` to the room and `lobby:rooms`
  globally.
- **Composer stability.** The stage composer and the "take a side" hint are two
  fixed elements toggled by role, not markup rebuilt on each `room:state`. A
  rebuild would wipe whatever a debater was mid-way through typing whenever
  anyone joined or left.
- **Calling it is two-step.** The first click on "Call it" arms the button and
  the second one fires. It disarms itself after four seconds rather than staying
  hot. One misclick would otherwise end the debate for everyone.
- **Class-name collision.** The gauge's neutral state is `.gauge.nocall`, not
  `.gauge.empty`. `.empty` was already the lobby's "no debates yet" placeholder,
  carrying `padding: 52px 0`, and padding floors an element's used height, so the
  15px gauge rendered 108px tall and its two fills collapsed to zero. Even an
  inline `height: 15px !important` could not shrink it.
- **Scroll.** New messages only auto-scroll when the reader is already within
  80px of the bottom, so scrolling back through history is not hijacked.
- **`localStorage`.** Name, voter id and stance handling are all wrapped in
  try/catch. Sandboxed embeds that block storage degrade to asking for a name
  each session and to a per-connection ballot.

## Look

"Paste-up", a punk flyer photocopied and stuck to a wall.

One loud thing: the ransom-note headline on the lobby, cut from three sources
and pasted in a row, the third line set as a lit neon tube. Everything else is
disciplined. A single hard shadow offset (4px, no blur), a single rotation
(-1.5deg), one spacing scale. Toner speckle sits under the whole page as a
fixed, click-through layer.

PRO and CON are treated as spot inks rather than as UI accent colours. Where the
two mix you get the overprint violet, and that derived colour, not an arbitrary
accent, carries the primary buttons, the typing indicator and the system lines.

Type is Bahnschrift, the industrial condensed face that ships with Windows, set
uppercase at two widths (75% for the headline, 87.5% elsewhere) against Cascadia
Mono for data and a serif for the arguments themselves. No webfonts, so nothing
to load.

Structurally the stage keeps a **registration seam**: a dashed rule down the
centre of the floor. Arguments stay on their own side of it, and the system
lines that mark someone crossing the floor sit on the seam and break it, so the
line records every crossing. It is a CSS grid, PRO in column one, CON in column
two, system lines spanning both, which is what guarantees an argument can never
drift across the seam. Below 760px the plates stack and the seam is dropped. The
permalink page reuses the same seam for its transcript.

The result card and the permalink both lead with the swing figure, set large and
tilted. It is the only number on either surface that answers "did anything
happen here", so nothing else is allowed to compete with it.

## Tests

```bash
node test-clients.js
```

Spawns its own server on port 3111, drives real WebSocket clients through a full
debate, prints PASS/FAIL per check, and exits nonzero on any failure. Set
`TEST_URL=ws://localhost:3000` to run against an already-running server instead.
Archived records go to a throwaway directory, so a run never lands in your own
archive.

71 checks. The first 40 cover the live room: lobby push on connect, topic
validation, room creation, joining a missing room, everyone starting as
audience, the `Guest` name fallback, the audience being blocked from the stage,
seat claiming and the rejection of a taken seat or a second seat, typing relayed
to others but not echoed to the sender, both message streams broadcasting to
every member, monotonic message ids, empty-message rejection, a late joiner's
histories and seat state, server-side truncation of a 5000-character message to
1000, raw storage of markup, the lobby listing, seat release, and a debater's
disconnect freeing their seat.

The remaining 31 cover the verdict and the record: an entry stance recorded at
join and the fact that re-joining cannot rewrite it, the undecided count in the
live tally, all four conclusion guards, a hand-computed verdict checked figure by
figure (panel, opening tally, closing tally, swing, winner, floor-crossings), a
closing tally that still counts a voter who walked out before the end, the
single shared headline, the `room:concluded` push, all four freeze rules, a
settled debate refusing re-entry and pointing at its permalink, the settled list
being pushed and the room dropping off the live floor, and then the permalink
itself: it serves the record, states the verdict, carries the transcript, runs no
script, 404s on an unknown id, rejects a traversal attempt in the id, and renders
stored markup inert.

Playwright is not installable here (no npm), so the browser pass was driven
against live tabs. Verified in the real DOM: create, claim PRO, post; a second
participant claiming CON and replying; audience-only view with a hint instead of
a composer; cross-tab delivery of stage messages, audience messages, system
lines and the typing indicator; the lobby updating live as seats fill; the
composer appearing the instant a seat ack lands; `<img src=x onerror=…>` as a
display name and `<script>alert(1)</script>` as a message both rendering as inert
text with zero injected nodes; closing the PRO tab freeing the seat in the
others; and the reconnect path, exercised by dropping the socket through a TCP
proxy, where the client backed off, reconnected, rejoined the still-live room
with both histories replayed, and correctly did not reclaim its old seat.

The verdict path was verified the same way, against a hand-computed expectation.
Two debaters and two voters, opening at PRO 0 / undecided 1 / CON 1 and closing
at PRO 2, with one voter crossing the floor. Predicted +3 to PRO, and that is
what the result card, the archived JSON and the permalink all showed. The
participants were disconnected and reconnected partway through, which also
confirmed that entry stances survive a dropped connection.

## Acceptance walkthrough

`node server.js`, then open http://localhost:3000 in three tabs.

1. Tab 1 creates "Should homework be abolished?", says where it stands, takes
   PRO, posts.
2. Tab 2 joins from the lobby, gives its own opening stance, takes CON, replies.
3. Tab 3 joins, sees no stage composer, chats in the sidebar, and picks a side
   on the gauge.
4. Tab 1 clicks "Call it" twice. All three see the verdict, the room freezes,
   and the debate appears under "settled" in the lobby with a permalink.

Tabs 2 and 3 need their `debateVoter` key in `localStorage` overridden to count
as separate ballots, since one browser profile is deliberately one voter.

## Known limits

- **Ballot stuffing.** `voterId` is client-supplied. Clearing storage or opening
  a private window buys another ballot. This is the honest cost of having no
  accounts, and the fix is accounts, not a cleverer id.
- **Single process.** Live rooms are in memory, so this does not scale past one
  server. The store is the only place that state lives, so moving to Postgres or
  SQLite means rewriting section 2 alone.
- **No moderation.** Anonymous display names, no reporting, no blocking.
- **Archive growth.** Unbounded on disk, by design. There is no pruning job and
  deliberately so.

## Not built: instant match

Considered and deliberately left out. Notes kept so the reasoning survives.

A ChatRoulette-style mode where you press a button and get dropped straight into
an argument with a stranger. It fits this codebase cheaply, because a matched
debate is just an ordinary room with both seats already filled: the stage,
history, audience sidebar, typing relay, reconnect, the disconnect path that
frees a seat, and now the verdict and the permalink all work unchanged.

What it would take:

- a queue in the store, `motionId -> { pro: [], con: [] }`
- handlers for `match:queue { motion, side }`, `match:cancel`, `match:next`
- on a pair: `store.createRoom(motion)`, seat both clients, push
  `match:found { roomId }` to each
- a seed pool of motions and a lobby view for the queue

Two things worth remembering if it ever gets built:

**Pair on disagreement, not availability.** ChatRoulette matches whoever happens
to be free. A debate should match a PRO against a CON on the same motion, so the
argument is real. Availability-matching is the obvious port and the worse
product.

**Instant matching needs traffic it will not have.** With a handful of users
online the queue never fills and the feature reads as broken. It should degrade
into a visible challenge board: a stance sits on the board until someone accepts
the other side, and live matching becomes the fast path for when both sides are
already waiting. Same feature, no empty-queue dead end, works on day one.

Seating both clients directly is the one place this breaks the current protocol
rule that everyone arrives as audience and claims a seat explicitly.
