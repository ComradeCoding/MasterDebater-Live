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

Node 22 or later, for the built-in global `WebSocket` the tests drive the
server with. Development and production both run Node 24.

## Zero dependencies

Running the app needs no `npm install` and no build step, and that is a choice
rather than a workaround. The one package in `package.json` is Playwright, as a
dev dependency for the browser tests; nothing the server runs comes from
`node_modules`. The server is built-in `http` plus a hand-rolled RFC 6455 WebSocket
implementation; the client is one static HTML file. Socket.IO would have been
the obvious pick, and it would have brought a reconnect protocol, a fallback
transport and a client bundle to solve problems this app does not have: every
browser it targets speaks WebSockets, and the reconnect it needs is twenty lines
of backoff.

What the choice buys is that every line that runs is in this folder. There is
no lockfile to audit, no transitive package that can be compromised upstream,
and nothing between a deploy and the code that was read. The WebSocket layer
is the largest thing written by hand, and it is about two hundred lines against
a stable RFC. The cost is that everything a library would have handled has to
be handled here, which is why the transport section below lists its own
protocol checks.

## Layout

```
debate-live/
  server.js           # static serving + WebSocket + all room/chat logic
  format.js           # rounds, turns and the schedule, pure data
  verdict.js          # verdict math, pure functions
  archive.js          # concluded debates on disk, one JSON file each
  db.js               # the live store's durable copy, in node:sqlite
  resultpage.js       # the permalink page, server-rendered
  card.js             # the permalink's share card, drawn as a PNG
  archivepage.js      # /archive and /u/<handle>, server-rendered
  public/index.html   # the entire frontend, markup, CSS and JS
  homesite/           # the ComradeCoding homepage, served on its own hosts
  tools/              # image codecs and utilities, mostly run by hand
  test-clients.js     # protocol-level end-to-end tests
  tests/              # the browser pass, in Playwright
  playwright.config.js
  data/               # archived debates and live.sqlite (gitignored)
```

Seven modules sit outside `server.js`. Five are about the record a debate
leaves behind, which outlives a live room. `format.js` is separate because it
is pure data and pure functions, while the running clock is state, so the
schedule and the timer live apart. `db.js` holds the SQL for the live store's
durable copy, so section 2 reads as a store rather than as a page of queries.

## Architecture

`server.js` is four sections, top to bottom:

1. **WebSocket transport.** `WSConnection`: handshake (SHA-1 of
   `Sec-WebSocket-Key` plus the RFC GUID), masked-frame parsing including the
   126 and 127 length forms, fragmentation via continuation frames, ping/pong,
   close handshake, and a 64 KB frame cap. Unmasked client frames, reserved
   bits, and oversized or malformed control frames close the connection.
2. **Store.** Every `Map` and array lives here behind a small API
   (`createRoom`, `addMember`, `takeSeat`, `appendMessage`, `openBallot`, ...),
   written through to SQLite as it changes. Handlers never touch the `Map` or
   the database directly.
3. **Handlers.** One function per message type. They validate, mutate the store,
   and broadcast. They return an ack payload; failure is `{ error: "…" }`, never
   a thrown exception.
4. **HTTP + wiring.** Static file serving with a path-traversal guard, the
   Host-header split between the two sites, the `/d/<id>` permalink route, the
   generated `robots.txt` and sitemap, the upgrade handler with its origin
   check, a per-connection rate limit, and a 30-second heartbeat.

The rate limit is a token bucket per connection: a burst of 20 messages,
refilling at 10 a second. Over that, an acked request gets `{ error: 'Slow
down.' }` and an unacked one is dropped. A client that keeps pushing through
200 refusals in a row is disconnected. It is sized so no person typing can hit
it and a script flooding broadcasts runs dry within two seconds.

That bucket guards the transport. A second, smaller one guards the
conversation: five messages per ten seconds on each stream, the stage and the
sidebar separately, per connection. Over that the reply is `{ error: 'slow
down' }`. Five in ten seconds is faster than anyone argues and slower than
anyone spams, and keeping the streams apart means a debater who has been
hammering the stage can still answer someone in the sidebar. Only a message
that was actually going to be posted spends a token; an empty one that was
going to be refused anyway is free.

### Surviving a restart

Live rooms used to be memory only, so every redeploy wiped every debate in
progress, which on a site that deploys on every push is most of them. The store
now writes through to SQLite, using Node's built-in `node:sqlite`, so there is
still nothing to install. Live rooms, seats, both message streams, ballots, the
clock, the floor's questions and votes, the challenge board and handles all
persist. The SQL lives in `db.js`; section 2 is still the only code that calls
it.

**Memory stays the working copy.** Every handler reads room state on every
message, and a room also holds things no database can, open sockets and
timers. So the store keeps its objects, writes each change through as it makes
it, and reads the database exactly once, at boot. A write that fails is logged
and the room carries on, since a debate should not stop mid-sentence because a
disk filled up; all that is lost is surviving the next restart.

**The archive stays JSON.** A settled debate is a record with a permanent URL,
and a folder of JSON files anyone can read without the app is the right shape
for that. The database holds the opposite: state that only matters while a
debate is still live. Settling a debate deletes its live rows, and its archive
file was written first, so nothing is ever in both places for long and nothing
is ever in neither. The database file, `live.sqlite`, sits next to the archive
under `ARCHIVE_DIR`, so in production it is on the same volume and survives a
redeploy for the same reason the archive does.

**The swap was not quite section 2 alone**, which this file used to promise. The
store API kept every method and signature, but three things the handlers did
were plain assignments to objects the store had handed out: flipping a ballot's
current lean, striking a ballot when its owner sat down, and the clock code
changing `room.turn`. A database cannot see an assignment, so those now go
through `setLean`, `strikeBallot` and `saveTurn`. That is a better rule
anyway: the store owns its objects, and nobody edits them behind its back.

**On boot**, every room that was live comes back with its history, ballots,
questions and turn. The clock comes back paused, whatever it was doing, and the
stage carries a system line saying the server restarted, which is the one
system line kept in the history, because a late arrival needs it to make sense
of a stopped clock. The time left on a turn that was running is measured
against when the process was last alive. A deploy sends SIGTERM first, and the
server pauses every running clock then, so the time is exact. A crash gives no
warning, so the server also writes a heartbeat every five seconds, and a crash
costs a turn at most five seconds, never the time the server spent down.

A restart is everybody's connection dropping at once, and a dropped connection
frees a seat. Taken literally, that would let anyone watching grab a debater's
seat while the debater's page was still reconnecting. So restored seats are
**held** for the browser that sat in them, matched on the same browser id the
ballots use, for the same five-minute grace period an empty room gets. The
lobby and the seat bar show the seat as away. The debater's own browser can sit
straight back down; anyone else is told who it is held for. When both are back
the clock runs again from where it stopped, through exactly the path an
emptied seat already used. A hold that runs out frees the seat. Challenges come
back too, every one of them marked away, since every poster is offline after a
restart; each reattaches when its page reconnects, or dies after the grace
period like any orphaned challenge. Message ids keep counting up across the
restart.

### Data model

```js
Room {
  id,              // 6 hex chars
  topic,
  createdAt,
  status,          // 'live' | 'concluded'
  result,          // the archived record, once concluded
  seats: { pro: { clientId, name, handle, voterId } | null,
           con: { clientId, name, handle, voterId } | null },
                   // clientId is null while a seat is held after a restart
  debateMessages: [ { id, role, name, text, ts } ],
  audienceMessages: [ … ],
  members: Set<Client>,
  ballots: Map<voterId, { entry, current, seated }>,
  turn: { index, endsAt, remainingMs, paused, pausedReason, over },
  questions: [ { id, voterId, name, text, ts, votes: Set<voterId> } ],
  pinnedQuestionId,
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
| `room:join` | `{ roomId, name, stance, voterId }` | `{ ok, room, role, debateMessages, audienceMessages, lean, myLean, myEntry, turn }` |
| `room:leave` | none | `{ ok }` |
| `seat:claim` | `{ side: 'pro' \| 'con', handle?, secret? }` | `{ ok, role, handle }` |
| `seat:release` | none | `{ ok, role: 'audience' }` |
| `debate:message` | `{ text }` | `{ ok }`, seated debaters only |
| `audience:message` | `{ text }` | `{ ok }`, anyone in the room |
| `audience:lean` | `{ side: 'pro' \| 'con' }` | `{ ok, lean }`, no neutral value exists |
| `debate:conclude` | none | `{ ok, result, url }`, seated debaters only |
| `debate:start` | none | `{ ok, turn }`, seated debaters only, both seats filled |
| `debate:pass` | none | `{ ok }`, only the side holding the floor |
| `debate:typing` | `{ isTyping }` | `{ ok }`, relayed from debaters only |
| `room:rematch` | none | `{ roomId, join }`, the two who argued a settled debate only |
| `audience:mute` | `{ clientId, mute? }` | `{ ok, muted }`, seated debaters only; `mute: false` lifts it |

Server pushes: `lobby:rooms` (live room summaries), `lobby:results` (settled
debates), `room:state` (one summary), `debate:message`, `audience:message`,
`debate:system`, `audience:system`, `debate:typing` `{ name, role, isTyping }`,
`room:lean` `{ pro, con, undecided }`, `debate:turn` (round, side, index, total,
remainingMs, paused), `room:concluded` `{ result, url }`, and `room:rematch`
`{ roomId, by, join }` to the debater who did not ask. A `debate:system` line
may carry a `roomId`, which the client renders as a link.

`join` is the same payload `room:join` acks with. Every path into a room hands
back that one shape, so the client has one function that paints a room and
does not care how it got there.

Room summary: `{ id, topic, createdAt, status, proTaken, conTaken, proName,
conName, proHandle, conHandle, proAway, conAway, audienceCount }`. `proAway` and
`conAway` mark a seat held for a debater who has not reconnected since a
restart.

Joining always lands you in the audience. Seats are claimed explicitly,
including after a reconnect. The two exceptions are a rematch and an accepted
challenge, where the act that seats you is the request itself; see below.

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

## The format

Without turns the stage is a free-for-all, which is an argument rather than a
debate: both sides type at once, the faster typist wins on volume, and there is
no shape to what the audience is being asked to judge.

A room opens with no format running and the stage wide open, which is what a
room is before it starts: people turning up, testing the mic, arguing loosely.
Either debater can call it to order once both seats are filled, and from then on
the floor is enforced.

```
Opening    PRO 3:00   CON 3:00
Rebuttal   PRO 2:00   CON 2:00    the floor asks and votes
Questions  PRO 2:00   CON 2:00    both answer the top question
Closing    PRO 1:30   CON 1:30
```

PRO speaks first in every round. The side proposing the motion carries the
burden of proof, so it leads and CON always answers, which also means the last
word in each round belongs to CON.

The table in `format.js` is pure data, and the turn list, the turn count and
the total running time all derive from it. Adding a round was one line plus a
flag; nothing in the clock code knows how many rounds there are.

### The floor's questions

Until the Questions round, the audience could watch, chat and vote with its
feet, but never put anything to the people on stage. Now it gets one round.

While the rebuttals run, each audience member can ask one question and vote
for any number of others. The rebuttals are the right window: the floor has
heard both cases by then and can see the holes in them. When the Questions
round opens, voting closes and the top question is pinned to the stage, pasted
over it on a slip of paper above the floor bar. PRO answers first, as always,
then CON answers the same question, so the two answers can be compared
directly. Ties go to whoever asked first. If nobody asked, the stage says so and
the round is open time.

The pin is chosen once, when the round opens, and it does not move. Voting is
closed by then on purpose; otherwise a question could be swapped out from under
PRO halfway through answering it.

Debaters cannot ask or vote, for the same reason they cannot pad the gauge. A
vote is a count on the wire, never a list of who voted, and the asker's ballot
id never leaves the server. Questions are part of the record, ranked as they
stood when voting closed, and the permalink lists them under the transcript with
the one put to both sides marked.

| Type | Data | Ack |
| --- | --- | --- |
| `audience:question` | `{ text }` | `{ ok, questionId }`, audience only, during the rebuttals, one each |
| `audience:upvote` | `{ questionId }` | `{ ok, votes }`, audience only, during the rebuttals, not your own |

Pushes: `room:questions` (the ranked list, `{ id, name, text, votes, pinned }`).
`debate:turn` gains `asking`, `answering` and, during the Questions round, the
pinned `question`. The join payload carries `questions`, plus `myQuestionId` and
`myVotes` so a reconnect does not offer a second question or a second vote.

**A turn is a window, not a single message.** You hold the floor for a stretch
and can post as many times as you like inside it, then yield or let the clock
take it. Anything stricter fights the medium: this is a chat box, and one
message per turn would force people to compose a paragraph in an input one line
tall.

Yielding early only ever gives the other side more time than they were owed, so
it needs no confirmation. Running out of time is announced on the stage and the
floor passes automatically.

The clock lives on the server and is the only thing that can advance a turn. The
client counts down from the last `remainingMs` it was sent, purely so the
seconds move; when its countdown hits zero it waits to be told rather than
advancing anything itself. That is why the wire carries a remaining duration
instead of an absolute deadline: a deadline would have every client differencing
its own clock against the server's, and those disagree by however far the
viewer's machine has drifted.

One timer per room, not one interval scanning all of them. A debate spends most
of its life with nothing due, and a global tick would wake up hundreds of times
a minute to discover exactly that.

### When a seat empties

The clock stops. A dropped connection is not a concession, and the reconnect
path already brings people back within seconds. Nobody can post while it is
stopped, including the side still in the room, so an opponent's bad wifi cannot
be farmed for free floor time. Refilling the seat restarts the clock with
whatever time was left, not a fresh turn.

### The end of the format settles the debate

The last turn running out calls it. A debate that went the full distance should
not also need somebody to remember to press a button, and "Call it" becomes the
early exit rather than the only exit.

That path can fail, and legitimately: a debater can walk out during the closing
round, leaving a seat empty and the transcript one-sided, which the settle
guards refuse. When that happens nothing is written, the format ends, and the
room stays live and callable by hand. The stage says so rather than failing
silently.

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

### Copy link and rematch

The result card offers the permalink to copy, because sharing it is the only
thing left to do with a settled debate. Where the clipboard API is missing or
refuses, the link goes in the toast instead, so the button never does nothing.

The two people who argued also get **Rematch**: same motion, a fresh room,
sides swapped. Swapping is the point. Arguing the side you just argued against
is the classic debating drill, and it tests whether a win came from the case or
from the side of the motion that happened to be easier.

Both debaters land in the new room already seated, which bends the rule that
everyone arrives as audience. The rule exists so a seat is a deliberate act,
and here it already was: each of them chose this motion and argued it, and
asking them to race for the seats again would be ceremony. They are struck from
the panel on arrival, exactly as claiming a seat would strike them. The other
debater is moved only if they are still looking at the result; someone who has
already gone into another room is not pulled back out of it, and their seat is
left open. A second click, or both asking at once, returns the rematch that
already exists. Everyone else watching the old result gets a system line with a
link, and goes through the join modal like any arrival, because their opening
stance on the second round is worth recording fresh.

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

### The share card

Most people meet a permalink as a preview in somebody else's feed before they
ever open it, so the preview is the page's real front door. `/d/<id>/card.png`
draws it: the masthead, the motion, both names on their spot-ink pills, the
swing figure large and tilted in a box with the page's hard shadow, and the
opening and closing bars on one scale. The permalink names it as `og:image`
and asks for a `summary_large_image` Twitter card.

It is a PNG because the platforms that draw previews take PNG and JPEG and not
SVG, so an SVG card would have been tidier to write and shown nowhere. That
means real pixels with no canvas and no font engine. `card.js` draws onto a
plain RGBA buffer and hands it to the PNG encoder in `tools/png.js`, which
makes that the one tool the server loads. The text is a 5x7 bitmap font drawn
taller than it is wide, so it condenses the way Bahnschrift does at 75%; blocky
capitals are what a photocopied flyer would have anyway. Anything the font
lacks is folded to the nearest thing it has, so an accented name loses its
accent rather than turning into noise. The tilt is the page's one rotation,
sampled sixteen times a pixel so its edges stay smooth.

The card hangs off the permalink's own route, so the id goes through the same
six-hex-char check before anything is read, and an unknown id is the same 404.
It is served under the same `script-src 'none'` policy. A record never changes
once written, so neither does its card: it is cached for a day downstream and
kept in a small in-memory cache here, so a link doing the rounds does not
redraw the same pixels for every crawler that asks.

Files are never deleted. An archive that quietly dropped old debates would break
exactly the permalinks it exists to keep, so disk grows without limit by design.
Only the in-memory lobby index is capped, at 200.

## The mothership

One server carries two sites, routed on the Host header. `comradecoding.com`
and `www` serve the ComradeCoding homepage from `homesite/`; every other host,
including the railway domain, serves the app. Two paths cut across the split so
both sites are reachable from anywhere: `/home` is the homepage on any host,
and `/arena` is the app on any host, which is what puts MasterDebater at
`comradecoding.com/arena` without spending a domain slot on a subdomain. The
`/d/` permalinks sit above the split entirely, so a settled debate shares from
either domain.

The homepage ships eight images, all of them supplied by the owner. Four are
animated GIFs: the hammer and sickle, a dancing Marx, a pixel-art book and a
guestbook mouse. Four are PNGs: the Ziggy portrait in the opposite corner, and
three nav icons (Trotsky, the boxing ring, and the Athletics fighter).
Everything else is drawn in CSS. It is a Geocities pastiche done honestly: the
animations run on `steps()` so they flicker like 8-frame GIFs, the marquee tags
are real, and the table layout is load-bearing on purpose.

It carries two scripts. `midi.js` synthesizes The Internationale with two
oscillators rather than shipping or embedding audio. The composition (De Geyter,
1888) is public domain; no recording of anyone's performance is involved, and
nothing is downloaded to play it. `bounce.js` sets Ziggy drifting round the
window, and keeps its motion in one pure function so the tests can check the
edge cases a running page never shows. Both sit in their own files rather than
inline, so the page runs under `script-src 'self'` and inline execution stays
banned, which is still tighter than the app's `'unsafe-inline'`.

Browsers refuse to start audio without a user gesture, so the page cannot blare
on load the way a real Geocities page did. It arms instead and starts on the
first click anywhere, and a visitor who presses STOP is remembered for the
session. The melody is a table of notes at the top of `midi.js`, reconstructed
by ear, so any wrong note is a one line fix.

`HOME_ASSETS` lists the files that belong to the homepage rather than the app.
They serve from the home root on every host, because the page reaches other
hosts by path at `/home` while its markup still asks for `/midi.js` at the root.
Without that the page renders silent everywhere except the bare domain, which is
the one place you would not think to check.

`HOME_HOSTS` overrides the routed hostnames, comma-separated, if the umbrella
ever moves.

Railway's plan allows two custom domains per service, which root and `www`
occupy. A `debate.` subdomain would need one of them deleted in the dashboard
first (the API can only detach a domain from a service, not delete the domain
object), or a plan upgrade. `/arena` made that unnecessary.

## Deployment

Live at https://masterdebater-live-production.up.railway.app

Railway, deployed from `ComradeCoding/MasterDebater-Live` on `main`. Pushing to
main builds and deploys automatically. Railway injects `PORT` (8080 in
production) and the server already reads it, so nothing is pinned.

WebSockets work through the proxy without changes. `originAllowed` compares the
`Origin` header's host against the `Host` header, and both are the public
domain behind a reverse proxy, so the cross-site guard holds without an
allowlist that would need editing per environment.

**The archive needs a volume or it is not an archive.** A Railway container's
filesystem is discarded on every redeploy, so without one, every settled debate
and every permalink dies the next time you push. A volume named
`debate-archives` is mounted at `/data`, and `ARCHIVE_DIR=/data` points the
archive at it. The live store's `live.sqlite` goes in the same directory, so the
same volume is what lets a debate in progress survive a push. Railway sends
SIGTERM before replacing a container, which is what lets the clocks stop at the
exact second rather than at the last heartbeat.

One trap worth recording, because it cost two redeploys to find. Creating the
volume through the API only *stages* the mount. The staged config and the
deployed config are different things, and they disagree silently: the Railway
agent's view of the service showed `volumeMounts` while `get-service-config`
showed none, and containers kept booting without the mount. Records written in
that window looked fine, because a container-local `/data` is perfectly
writable and readable, and then vanished on the next deploy. Committing the
staged change is a separate step, and only after it does `Mounting volume on:
…` appear in the boot log.

The check that actually proves it is worth keeping: conclude a debate, confirm
its permalink returns 200, redeploy, and confirm it still returns 200. Boot logs
report the count at startup, so `1 settled debate in the archive` after a
restart is the short version of the same proof. Anything less than a redeploy
tests nothing, since the pre-mount failure mode reads as success until the
container is replaced.

There is no way to delete an archived debate from inside the app. Removing one
means deleting its JSON file on the volume by hand.

## The clip art, and the tools that clean it up

`tools/` holds three utilities and the two codecs they share: `png.js` reads and
writes 8-bit RGBA PNGs, and `gif.js` reads and writes animated GIFs, LZW and
all. None of them runs at build time; the images in `homesite/` are already
processed. The PNG encoder is the one exception at serve time, because the share
card is drawn per request. They are kept because every one of these problems recurs each time
an image is added.

`dechecker.js` cuts a baked-in transparency checkerboard out of a PNG. Stock
sites advertising a transparent PNG often serve the preview with the checker
drawn into the pixels, so the file has an alpha channel and every pixel in it
is opaque. Two of the images here arrived that way. It samples the checker
greys from a corner and floods inward from the border, rather than replacing
every matching pixel, which would punch holes through any near-white inside
the subject.

`resize.js` downscales to the size an image is actually drawn at. The ring
arrived at 1280px and is rendered as a 26px icon, which cost a megabyte to draw
something the size of a full stop. It box-filters on premultiplied alpha:
averaging colour and alpha separately drags the colour of transparent pixels
into the edge, which on a cut-out is a halo of whatever used to be behind the
subject.

Order matters. Cut the checker at full resolution, then downscale, so the
checker colours are still flat when they are matched and the alpha edge gets
anti-aliased on the way down.

`gifresize.js` does the same job for animated GIFs, which is a harder one,
because Node ships zlib for PNG and nothing at all for GIF. The codec decodes
to whole composed frames, so the resampler only ever sees plain RGBA images,
then re-encodes with one shared palette cut by median split, only the
rectangle each frame changed, and a disposal plan that wipes exactly what the
next frame needs dark. The icons are sized to a whole multiple of what the
stylesheet draws: twice for the sickle (32x36 at 18px) and the mouse (42x52 at
26px), three times for the book (66x60 at 22px) because it renders pixelated.
A clean ratio matters more than raw size; at one and a half the browser lands
between pixels the whole way across and looks worse than a smaller file would.

The page carries about 1.5 MB of clip art, down from 3.4 MB. The three icon
GIFs went from 337 KB to 44 KB between them. What is left is almost entirely
two files that are correctly sized for what they are: Ziggy at true 2x for a
480px corner (830 KB), and Marx (570 KB), whose GIF is 165x267 and is
therefore being scaled up rather than down. Neither has anything left to give
without visibly losing frames or colour, and the tests hold the icons to a byte
budget so a full-size file dropped back in fails loudly.

## The mute and the denylist

A debater on stage gets every sidebar line in their peripheral vision, and a
heckler who is only there to put them off can do it all debate long. So either
debater can mute an audience member, for themselves only. Each sidebar line
carries `clientId`, a per-room public id hashed from the speaker's browser id,
so a mute survives the muted person reconnecting and nobody can work back from
it to the ballot id it came from. The server keeps each debater's mute list
(it persists with the room), sends it back in every join ack, and goes on
sending the muted person's lines; the debater's own browser does the hiding.
Nobody else's view changes and the muted person is never told, because a mute
that announced itself would be a prize. The audience cannot mute anyone, and
nobody can mute themselves. `mute: false` lifts one, and the sidebar offers
that as a single "show all".

Names get a denylist, kept short because a long one mostly catches the
innocent. Two kinds of entry. A name that is entirely a claim to be the site or
its staff (`admin`, `moderator`, `system`, the site's own names) is refused,
but "Administrator Matt" is fine. A handful of slurs are refused anywhere in a
name, after folding case, accents, spacing and the usual digit-for-letter
swaps, so spacing a word out or writing it in numbers does not get it through.
Words that commonly sit inside ordinary names were left off the list on
purpose. It is checked on the server, on join, on the board and on handle
claims, before anything else changes.

## Handles

Not accounts. A display name is whatever you typed into the join box this
time, so a debater's history was scattered across every name they ever used.
A handle is a name a record collects under.

The browser makes 32 random bytes the first time it loads the page and keeps
them in `localStorage`. A seat claim, a challenge post or a challenge accept can
carry a handle and those bytes. The first claim of a handle binds it to a
SHA-256 of the bytes; the bytes themselves are never stored. Any later claim
with different bytes gets `{ error: 'handle taken' }`, and the comparison is
constant time. The handle is checked last, after every other reason the claim
could fail, so a seat claim that was going to be refused anyway cannot burn
somebody's handle on its way out. A handle is optional, and a seat can still be
taken without one.

The handle is stored on the seat, shown under the name in the seat bar, written
into the record, and linked from the permalink. A rematch keeps it, and a
challenge remembers it for when the poster's match comes, even if they have
reloaded since posting.

`/u/<handle>` lists every debate that handle argued, newest first, with the
side, the swing from their side of it (swing is stored from PRO's point of
view, so it is flipped for CON), and won, lost or drew. Each row carries the
running total as it stood after that debate, and the top of the page carries
the career: net people moved, settled, won, lost, drawn. It draws from an index
of the whole archive rather than the 200 the lobby holds, because a debater's
page that quietly dropped their early debates would be a worse lie than the
lobby forgetting them. Same rules as the other record pages: the handle is
matched against its exact shape before anything is looked up, nothing runs, and
a handle nobody has claimed or argued under is a 404.

**Losing storage loses the handle.** Clear the site's data, switch browsers or
open a private window, and that browser has no key, so the handle is gone for
good; there is no recovery, because there is nothing to recover it with. This
is deliberately the smallest honest step toward the accounts that the known
limits keep deferring: it gives a debater continuity without collecting an
email address or a password, and it is the piece an account system would sit
on top of, since an account is a handle with a better way to prove you hold it.

## The archive

The lobby shows the fifty most recent results, which is a feed, not a record.
`/archive` lists everything the in-memory index holds, with a search box over
the motion and both names and three orders, each answering a different
question:

- **Newest** is what happened lately.
- **Biggest swing** is where somebody actually moved the room, either way.
- **Most contested** is the close ones: the smallest margin first, then the
  most people crossing the floor to get there. Two debates that ended level are
  not equally close if half the room changed sides in one of them and nobody
  moved in the other.

Search wants every word somewhere in the motion or either name, in any order,
ignoring case and accents. It is a plain GET form and the sorts are plain
links, so the page runs no script at all and the URL is the whole state: a
search can be bookmarked or sent to someone. Search results carry `noindex`,
because a crawler following every query string would file the same records a
hundred times.

The policy is the permalink's with one change. Its search box submits to
itself, and `form-action 'none'` would block that, so this one page allows
`form-action 'self'`. Scripts stay at `'none'`. The terms are echoed back into
the box through the same escaping as everything else, because a query string is
user input. The page is above the site split, like the permalinks it lists, so
it works on either domain, and the lobby's settled list links to it.

It lists what the index holds, the most recent 200, the same bound the sitemap
uses, so the three surfaces agree. Older permalinks keep working, they just stop
being listed, and the page says so once it is at the cap.

## Crawlers

`/robots.txt` and `/sitemap.xml` are generated, not files, so a debate is
listed the moment it is settled and nothing has to be regenerated by hand. The
sitemap carries the homepage, the arena, the archive, and every archived debate
with its concluded date, which are the pages worth finding: permanent,
self-contained, and the only reason anyone outside a room ever arrives.

`SITE_ORIGIN` names the address everything should be filed under. Set it in
production and every generated link points at the real domain whichever host
served the request. Leave it unset and the site talks about itself using
whatever host asked, which is what local development wants.

It also settles a duplicate-content problem the two domains would otherwise
create. The same page reachable at both `comradecoding.com` and the railway
domain is the same page indexed twice, with the search engine picking the
winner. Any host that is not the canonical one now serves `Disallow: /`, and
all three page types carry a `rel="canonical"` pointing home.

The sitemap lists what the in-memory archive index holds, currently 200, so it
and the lobby agree by construction. Older records stay on disk and keep
working; they simply stop being advertised.

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
node test-clients.js      # the protocol, 262 checks, no dependencies
npm install               # once, for the browser pass only
npx playwright install chromium
npm run test:browser      # the page, in real Chromium tabs
```

Two suites, for two different questions. The protocol suite asks whether the
server does the right thing, and it needs nothing but Node. The browser suite
asks whether the page shows what the server said, in the right place, inert,
and that genuinely needs a browser.

### The protocol suite

Spawns its own server on port 3111, drives real WebSocket clients through a full
debate, prints PASS/FAIL per check, and exits nonzero on any failure. Set
`TEST_URL=ws://localhost:3000` to run against an already-running server instead.
Archived records go to a throwaway directory, so a run never lands in your own
archive.

There is no test framework, for the same reason there is no Socket.IO. A check
is a name and a boolean, and the runner is forty lines at the top of the file.
Node 22 ships a global `WebSocket` client, so the tests speak to the server
through the same API a browser uses.

262 checks. The server is spawned with `DEBATE_TURN_SECONDS=1`, so an eight-turn
format runs in eight seconds rather than seventeen minutes.

The first 40 cover the live room: lobby push on connect, topic
validation, room creation, joining a missing room, everyone starting as
audience, the `Guest` name fallback, the audience being blocked from the stage,
seat claiming and the rejection of a taken seat or a second seat, typing relayed
to others but not echoed to the sender, both message streams broadcasting to
every member, monotonic message ids, empty-message rejection, a late joiner's
histories and seat state, server-side truncation of a 5000-character message to
1000, raw storage of markup, the lobby listing, seat release, and a debater's
disconnect freeing their seat.

The next 46 cover the verdict and the record: an entry stance recorded at
join and the fact that re-joining cannot rewrite it, the undecided count in the
live tally, all four conclusion guards, a hand-computed verdict checked figure by
figure (panel, opening tally, closing tally, swing, winner, floor-crossings), a
closing tally that still counts a voter who walked out before the end, the
single shared headline, the `room:concluded` push, all four freeze rules, a
settled debate refusing re-entry and pointing at its permalink, the settled list
being pushed and the room dropping off the live floor, and then the permalink
itself: it serves the record, states the verdict, carries the transcript, runs no
script, 404s on an unknown id, rejects a traversal attempt in the id, and renders
stored markup inert. Its share card serves as a real 1200x630 PNG under the same
policy, 404s on an unknown id or a traversal attempt, and is named by the page's
`og:image` and large Twitter card tags. A rematch refuses the audience, seats the
caller on the other side, pushes the other debater onto theirs, hands everyone
else a link, returns the same room when asked twice, and opens live.

The next 23 cover the format: a room starting with no format running, the
audience being unable to call it to order, the guard on an unfilled seat, the
stage staying open during warm-up, PRO opening, the eight-turn schedule, refusing
to start twice, the floor blocking the side that does not hold it, a turn
allowing more than one message, yielding a floor you do not hold, yielding
handing over and locking the yielder out, the clock advancing a turn with nobody
acting, an emptied seat stopping the clock and freezing both sides out, a
refilled seat resuming the same turn rather than restarting it, and the last
turn settling the debate on its own with a normal record and a working
permalink.

The next 19 cover the floor's questions: none before the rebuttals, none from
the stage, one each, no voting for your own and no double vote, the list pushed
ranked and without ballot ids, the Questions round following the rebuttals
with PRO first and the top question pinned, asking and voting closing as it
opens, a late arrival seeing the pin, CON answering the same question, the pin
coming down for the closings, and the record and the permalink carrying the
questions ranked, without ballot ids, under the transcript and escaped.

The next 15 cover the archive: it lists every settled debate, runs no script
and relaxes only its own form, opens newest first, sorts by swing and by
contest, falls back on an unknown sort, finds a motion by every word and a
name in any case, combines search with sort, says when nothing matches,
escapes the terms it echoes, keeps search results out of the index, is in the
sitemap, and is linked from the lobby.

The next 20 cover handles: a handle has a shape and needs a full key, the
first claim binds it and stores it on the seat, the key never reaches anyone
else, a different key gets exactly "handle taken" without taking the seat, the
handles go into the record without the key, the same key claims it again from
a new connection, a seat still works with no handle, and the debater's page:
what they argued, side and swing and result from their side, a running total,
the other side of the same debate reading as a win, no script, 404s for an
unclaimed handle and a traversal attempt, no key on the page, and the
permalink linking each handle.

The next 18 cover moderation: an impersonating name and a spaced-out, numbered
slur refused at the door while an ordinary name containing a reserved word gets
in, a reserved handle refused, five sidebar messages through and the sixth
told "slow down", one person's limit not touching anyone else, the stage with
its own five, the sidebar unaffected when the stage runs out, a rejected
message spending nothing, every sidebar line carrying a speaker id and no
ballot id, the audience unable to mute, a debater muting for themselves but
not themselves, the muted person not told, the list returning in the join ack,
another member's list staying empty, and a mute lifted.

The next 25 cover the challenge board: it is pushed on connect, a challenge
needs a motion and a side, it goes up on every board without the poster's
browser id, one per person, no taking your own, withdrawing, a match pushing
both people into one room seated on the right sides with the motion, the
challenge coming off the board and refusing a second taker, the room on the
live floor with both arguing straight away, a seated debater not being pulled
out of a live debate, a dropped poster marked away and untakeable, a reload
reclaiming it inside the grace period, and the two timed deaths: a poster gone
past the grace period, and nobody taking it in time.

The restart checks run last, against a second server on its own port and
directory, killed outright mid-debate with no chance to shut down cleanly. 13
of them: the live room coming back with its seats held, challenges coming back
away, the transcript, the restart line, ballots with both the entry stance and
the lean, the clock paused on the same turn with its time, a held seat refusing
someone else and returning to its own browser, the clock running again, message
ids still counting up, handles surviving, and a settled debate not coming back
as live while its permalink still stands.

The next 31 cover the mothership: Host-header routing to the homepage on both
home hosts and the app everywhere else, `/home` and `/arena` crossing the split,
the homepage's stricter script policy and its `media-src` allowance, the
bouncing corner's pure step function (never leaving the window, turning at the
edges, surviving a backgrounded tab's long frame gap, parking in a window
smaller than itself), `robots.txt` and the sitemap, and every homepage asset
serving on both hosts with the right type.

The last 12 cover the GIF codec: LZW round trips at every code width, the
dictionary rebuilding when it fills, every homepage GIF surviving decode,
encode and decode unchanged, and the three icons staying under their byte
budgets at a whole multiple of their drawn size.

### The browser suite

Playwright is the one dependency in the project, and it is a dev dependency:
`npm start` still installs nothing and the server still loads nothing from
`node_modules`. It drives the pass this section used to describe as done by
hand, so it now runs on every change instead of once. The config starts its own
server on port 3122 with a throwaway archive, the same way the protocol suite
does. Each participant is a separate browser context, which is separate
storage and therefore a separate voter, exactly like separate people, and any
uncaught error in any page fails the test that opened it.

One end-to-end debate in five tabs: create a room, claim PRO under a handle and
post; the lobby updating live as the seat fills; a drifter claiming CON and
closing their tab, which frees the seat in the other tabs; a second person
joining from the lobby, seeing the history replayed, claiming CON and replying;
the audience view with a hint instead of a composer, sidebar chat delivered
across tabs, and a lean moving the gauge; the typing indicator crossing tabs;
`<img src=x onerror=a()>` as a display name and a `<script>` tag as a message
both rendering as inert text, with zero injected nodes and nothing executed in
any tab; the start row only for the debaters, the floor bar opening PRO with
the other composer inert and saying why, posting on the floor and yielding it
across; the two-click call, the result card replacing every composer, the swing
and the headline, Rematch shown to the two debaters and to nobody else; the
permalink rendering the record under its no-script policy; and the rematch
swapping the seats in both tabs.

Then the archive's search running as a real form, a debater's page showing the
loss from their side, and a challenge posted in one tab and taken in another,
with both landing on the stage seated on the right sides.

What is still checked by hand is the reconnect path through a dropped TCP
connection, which needs a proxy between the browser and the server, and
anything visual that a selector cannot judge, such as whether the tilt on a
pasted slip lands on top of the bar below it.

## Acceptance walkthrough

`node server.js`, then open http://localhost:3000 in three tabs.

1. Tab 1 creates "Should homework be abolished?", says where it stands, takes
   PRO, posts.
2. Tab 2 joins from the lobby, gives its own opening stance, takes CON, replies.
3. Tab 3 joins, sees no stage composer, chats in the sidebar, and picks a side
   on the gauge.
4. Tab 1 clicks "Start the debate". The floor bar opens on PRO with a running
   clock; tab 2's composer goes inert until the floor passes to it.
5. Either debater clicks "Call it" twice to end early, or the eight turns run out
   and the format settles it. All three see the verdict, the room freezes, and
   the debate appears under "settled" in the lobby with a permalink.

Tabs 2 and 3 need their `debateVoter` key in `localStorage` overridden to count
as separate ballots, since one browser profile is deliberately one voter.

## Known limits

- **Handles are only as durable as browser storage.** See Handles: a cleared
  profile loses its handle permanently. That is the price of not having
  accounts, and handles are the first step toward them, not a substitute.
- **Ballot stuffing.** `voterId` is client-supplied. Clearing storage or opening
  a private window buys another ballot. This is the honest cost of having no
  accounts, and the fix is accounts, not a cleverer id.
- **Single process.** Live rooms survive a restart now, but the working copy is
  still one process's memory, so this does not scale past one server. Two
  servers would need the database to be the working copy, read on every
  message, which is a different design rather than a bigger one.
- **Moderation is thin, on purpose.** What exists: the transport flood guard
  and a five-in-ten-seconds limit on each stream; a short server-side denylist
  of names that impersonate the site and of slurs however they are spelled,
  checked on join, on the board and on handles; and a mute any debater can set
  on any audience member, for themselves only, kept across reconnects and
  restarts and invisible to the person muted. What does not: no reporting, no
  bans, no moderators, no filtering of what anyone says, no way for the
  audience to mute anyone, and nothing that survives a person clearing storage
  and coming back. Every one of those needs an account to hang off, which is
  the same wall the ballot and the handle hit.
- **Archive growth.** Unbounded on disk, by design. There is no pruning job and
  deliberately so.

## The challenge board

Instant matching was considered first and left out, and the reasoning is kept
because the board is built on it.

A ChatRoulette-style mode, where you press a button and get dropped straight
into an argument with a stranger, fits this codebase cheaply: a matched debate
is just an ordinary room with both seats already filled, so the stage, history,
audience sidebar, typing relay, reconnect, the disconnect path that frees a
seat, the verdict and the permalink all work unchanged. Two things argued
against building it as a queue.

**Pair on disagreement, not availability.** ChatRoulette matches whoever happens
to be free. A debate should match a PRO against a CON on the same motion, so the
argument is real. Availability-matching is the obvious port and the worse
product.

**Instant matching needs traffic it will not have.** With a handful of users
online the queue never fills and the feature reads as broken. So it is built as
the thing the queue should degrade into: a visible board. A visitor posts a
motion and takes one side; it sits on the board until somebody accepts the
other side. Same feature, no empty-queue dead end, works on day one, and live
matching is just what the board does when both sides happen to be online.

The board sits above the live floor in the lobby, because a challenge is an
open invitation and a live room is something already happening. Nothing is
seeded. An empty board shows one line inviting the first post, rather than a
handful of fake motions that would make the site look busier than it is.

When a challenge is taken, the server creates a room with the motion, seats the
poster on the side they posted and the taker on the other, and pushes
`match:found` to both with the same join payload a normal join returns.

**This is where someone arrives seated**, as the notes above always predicted.
The rule that everyone joins as audience exists so taking a seat is a
deliberate act, and posting or taking a challenge is that act. Neither of them
goes through the stance modal either: a stance is evidence for the verdict, and
anyone seated is struck from the panel anyway. The rematch is the other path
that seats people directly, for the same reason. Nobody is ever moved out of a
live seat to fill one: a challenge cannot be taken while either party is
mid-debate, since that would break the debate they are in.

**Lifetimes.** A challenge expires after 24 hours. It also dies if its poster
disconnects and stays gone for five minutes, the same grace period, and the same
re-check-when-the-timer-fires pattern, as an empty room. While the poster is
away the challenge stays up, marked as away, and nobody can take it, because a
match with nobody on one side is not a match. One challenge per person at a
time, and a hundred on the board at most.

Posters are recognised by the same browser-held id the ballots use, so a reload
or a dropped socket reattaches the challenge (`challenge:reclaim`, sent on every
connect) and cancels the timer. That id never appears on the board: it is a
ballot id too, and publishing it would let anyone resume someone else's ballot.

| Type | Data | Ack |
| --- | --- | --- |
| `challenge:post` | `{ motion, side, name, voterId }` | `{ ok, challenge }` |
| `challenge:accept` | `{ challengeId, name, voterId }` | `{ ok, roomId }`, then `match:found` to both |
| `challenge:withdraw` | `{ challengeId? }` | `{ ok }`, your own only |
| `challenge:reclaim` | `{ voterId }` | `{ ok, challengeId }`, or `null` if none |

Pushes: `lobby:challenges` (the whole board, on connect and on every change)
and `match:found` `{ roomId, by, join }`. A challenge on the wire is `{ id,
motion, side, name, createdAt, expiresAt, away }`.
