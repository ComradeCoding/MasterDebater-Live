# MasterDebater Live

A real-time debate platform shaped like a boxing ring with a crowd. Two debaters
claim the **PRO** and **CON** seats and argue on a central stage; an unlimited
audience watches and talks in its own sidebar chat. Everything is live over
WebSockets.

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

There is no `package.json`, no `npm install`, no build step. The server is
built-in `http` plus a hand-rolled RFC 6455 WebSocket implementation; the client
is one static HTML file. Socket.IO would have been the default choice, but npm
is unavailable in this environment, so the spec's sanctioned zero-dependency
fallback is what's implemented here.

## Layout

```
debate-live/
  server.js           # static serving + WebSocket + all room/chat logic
  public/index.html   # the entire frontend — markup, CSS, JS
  test-clients.js     # protocol-level end-to-end tests
  README.md
```

## Architecture

`server.js` is four sections, top to bottom:

1. **WebSocket transport** — `WSConnection`: handshake (SHA-1 of
   `Sec-WebSocket-Key` + the RFC GUID), masked-frame parsing including the 126
   and 127 length forms, fragmentation via continuation frames, ping/pong, close
   handshake, and a 10 MB frame cap. Unmasked client frames, reserved bits, and
   oversized or malformed control frames close the connection.
2. **Store** — every `Map` and array lives here behind a small API
   (`createRoom`, `addMember`, `takeSeat`, `appendMessage`, …). Handlers never
   touch the `Map` directly, so moving to Postgres or SQLite means rewriting
   this section alone.
3. **Handlers** — one function per message type. They validate, mutate the
   store, and broadcast. They return an ack payload; failure is
   `{ error: "…" }`, never a thrown exception.
4. **HTTP + wiring** — static file serving with a path-traversal guard, the
   upgrade handler, and a 30-second heartbeat.

State is in-memory, so restarting the server clears every room.

### Data model

```js
Room {
  id,              // 6 hex chars
  topic,
  createdAt,
  seats: { pro: { clientId, name } | null,
           con: { clientId, name } | null },
  debateMessages: [ { id, role, name, text, ts } ],
  audienceMessages: [ … ],
  members: Set<Client>   // each client has role 'pro' | 'con' | 'audience'
}
```

Server-enforced limits: topic ≤ 140 chars, name ≤ 24, message ≤ 1000, 200
messages of history per stream per room (oldest dropped). All input is trimmed;
empty-after-trim is rejected. Rooms are deleted five minutes after going empty,
with the emptiness re-checked when the timer fires.

## Protocol

Client → server: `{ id?, type, data }`. When `id` is present the server replies
`{ ackId: id, data: <result> }`.

| Type | Data | Ack |
| --- | --- | --- |
| `room:create` | `{ topic }` | `{ roomId }` |
| `room:join` | `{ roomId, name }` | `{ ok, room, role, debateMessages, audienceMessages }` |
| `room:leave` | — | `{ ok }` |
| `seat:claim` | `{ side: 'pro' \| 'con' }` | `{ ok, role }` |
| `seat:release` | — | `{ ok, role: 'audience' }` |
| `debate:message` | `{ text }` | `{ ok }` — seated debaters only |
| `audience:message` | `{ text }` | `{ ok }` — anyone in the room |
| `debate:typing` | `{ isTyping }` | `{ ok }` — relayed from debaters only |

Server → client pushes: `lobby:rooms` (array of room summaries), `room:state`
(one summary), `debate:message`, `audience:message`, `debate:system`,
`audience:system`, `debate:typing` `{ name, role, isTyping }`.

Room summary: `{ id, topic, createdAt, proTaken, conTaken, proName, conName,
audienceCount }`.

Joining always lands you in the audience — seats are only ever claimed
explicitly, including after a reconnect.

## Design notes

A few behaviours exist specifically to avoid bugs that showed up in the
prototype:

- **Seat-claim race.** `room:state` is broadcast before the caller's ack
  resolves, so the client's role-dependent UI would render against a stale role.
  The client sets `myRole` from the ack and then calls `renderRoom()` explicitly.
- **Escaping.** The server stores raw text. Every name, topic, and message is
  escaped at render time; nothing user-supplied reaches `innerHTML` unescaped.
- **Zombie seats.** Leaving and disconnecting share one `leaveRoom()` path, so a
  closed tab frees its seat exactly like the Leave button does.
- **Lobby staleness.** Every summary-changing mutation goes through
  `publishRoom()`, which sends both `room:state` to the room and `lobby:rooms`
  globally.
- **Composer stability.** The stage composer and the "take a side" hint are two
  fixed elements toggled by role, not markup rebuilt on each `room:state` — a
  rebuild would wipe whatever a debater was mid-way through typing whenever
  anyone joined or left.
- **Scroll.** New messages only auto-scroll when the reader is already within
  80px of the bottom, so scrolling back through history isn't hijacked.
- **`localStorage`.** Name persistence is wrapped in try/catch; sandboxed embeds
  that block storage degrade to asking for a name each session.

## Look

**"Out of register"** — the debate as a two-ink screenprint on black stock.

PRO and CON are treated as spot inks rather than as UI accent colours. The
signature is misregistration: the wordmark and the lobby headline print three
plates a few pixels apart, so the two sides never quite line up. Where the inks
overlap you get the overprint violet (`#7a3bff`), and that derived colour — not
an arbitrary accent — carries the primary buttons, the typing indicator, and the
system lines. Press grain sits under the whole page as a fixed, click-through
layer.

Type is Bahnschrift, the industrial condensed face that ships with Windows, set
uppercase at two widths (75% for the headline, 87.5% elsewhere) against Cascadia
Mono for data. No webfonts, so nothing to load.

Structurally the stage keeps a **registration seam**: a dashed rule down the
centre of the floor. Arguments stay on their own side of it, and the system
lines that mark someone crossing the floor sit *on* the seam and break it, so the
line records every crossing. It is a CSS grid — PRO in column one, CON in column
two, system lines spanning both — which is what guarantees an argument can never
drift across the seam. Below 760px the plates stack and the seam is dropped.

Only CSS changed in this pass. Every id and class the JS touches is untouched, so
behaviour and the escaping guarantees are unaffected — re-verified after the
change (31/31 protocol checks, script and img payloads still inert).

## Tests

```bash
node test-clients.js
```

Spawns its own server on port 3111, drives five real WebSocket clients through a
full debate, prints PASS/FAIL per check, and exits nonzero on any failure. Set
`TEST_URL=ws://localhost:3000` to run against an already-running server instead.

31 checks cover: lobby push on connect, topic validation, room creation, joining
a missing room, everyone starting as audience, the `Guest` name fallback, the
audience being blocked from the stage, seat claiming and the rejection of a
taken seat or a second seat, typing relayed to others but not echoed to the
sender, both message streams broadcasting to every member, monotonic message
ids, empty-message rejection, a late joiner's histories and seat state,
server-side truncation of a 5000-character message to 1000, raw storage of
markup, the lobby listing, seat release, and a debater's disconnect freeing
their seat.

Playwright is not installable here (no npm), so the browser pass was run by
driving four live browser tabs against the server. Verified in the real DOM:
create → claim PRO → post; join → claim CON → reply; join → audience-only
(hint instead of a composer) → sidebar chat; cross-tab delivery of stage
messages, audience messages, system lines, and the typing indicator; the lobby
updating live as seats fill; the composer appearing the instant a seat ack lands
(the seat-claim race); `<img src=x onerror=…>` as a display name and
`<script>alert(1)</script>` as a message both rendering as inert text with zero
injected nodes; closing the PRO tab freeing the seat in the others; a fresh
fourth tab receiving both histories in full; and the reconnect path, exercised by
dropping the socket through a TCP proxy so the server kept its state: the client
backed off, reconnected, rejoined the still-live room with both histories
replayed, toasted `Reconnected.`, and correctly did *not* reclaim its old seat.

## Acceptance walkthrough

`node server.js`, then open http://localhost:3000 in three tabs.

1. Tab 1 creates "Should homework be abolished?", takes PRO, posts.
2. Tab 2 joins from the lobby, takes CON, replies.
3. Tab 3 joins, sees no stage composer, chats in the sidebar.

All three see everything live. Closing tab 1 frees the PRO seat in the others
within a second, and a fresh fourth tab sees the full history.

## Not built: instant match

Considered and deliberately left out. Notes kept so the reasoning survives.

A ChatRoulette-style mode where you press a button and get dropped straight into
an argument with a stranger. It fits this codebase cheaply, because a matched
debate is just an ordinary room with both seats already filled: the stage,
history, audience sidebar, typing relay, reconnect, and the disconnect path that
frees a seat all work unchanged.

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
