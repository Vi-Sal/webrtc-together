# Together 2.0 — Liquid Glass Edition

Design and engineering notes for the 2.0 refactor: the redesigned UI, live chat and the collaborative whiteboard. Stack unchanged: Java 21, Spring Boot 4.1 (Web MVC + raw WebSocket), plain HTML/CSS and native ES modules. No frontend framework, build step, database or new infrastructure.

## 1. Review of the 1.x architecture

| Area | Finding | 2.0 action |
| --- | --- | --- |
| Signaling | `RoomHandler` held membership and relayed `signal` messages under one global lock. Sender IDs were derived on the server (good). | Kept the lock and the envelope; added chat/board/presence types; moved rules into services. |
| Identity | The WebSocket session ID was the public participant ID, so it changed on every reconnect. | Server-issued participant IDs plus a rotating, single-use **resume token** keep identity across reconnects. |
| Outbound sends | Synchronous sends while holding the global lock: one slow client could stall every room. | Each session sends through `ConcurrentWebSocketSessionDecorator` (10 s / 4 MB bound). Over-limit clients are disconnected. |
| Rooms | Empty input joined a shared `DEFAULT_NAME` room, so strangers met by accident. | "Start a meeting" generates an unguessable code. `DEFAULT_NAME` and other old `?room=` links still work when entered explicitly. |
| Reconnects | A dropped socket ended the call and released all media. | Automatic reconnect with backoff (90 s budget): local media stays live, peers renegotiate, and chat/board state resyncs. |
| Validation | Display names kept control and bidi-override characters. No rate limits. Unknown types were ignored silently. | Names/text are sanitized server-side, per-participant token buckets apply, and unknown types get an error reply. |
| Frontend | One 22 KB script with globals mixing DOM, media and signaling. Minified one-line CSS with hard-coded colors. | ES modules split by concern, a CSS token system and an explicit UI store. |
| Media | The three-slot transceiver mesh (audio/camera/screen) was solid. | Preserved as-is in `core/peers.js`. Camera-off now stops the device (light off) instead of disabling the track. |

Nothing in 1.x was broken for its scope. Losing a call on any signaling blip was the main reliability gap.

## 2. Frontend structure

```text
static/
  index.html               semantic markup for all three screens + SVG icon sprite
  device.js                browser device hints (unchanged classic script)
  css/  tokens · base · glass · landing · lobby · meeting · chat · whiteboard · responsive
  js/
    theme-init.js          pre-paint theme (prevents flashing)
    app.js                 screen routing: landing → lobby → meeting
    core/                  signaling, media, peers, audio-levels, room, theme, state, chat-model
    components/            landing, lobby, meeting, tiles, chat, feedback (toasts/dialogs)
    whiteboard/            geometry, model, renderer, whiteboard (UI + pointer input)
    utils/                 dom, emitter, format, ids
```

The meeting UI store (`view`, `panel`, `menuOpen`) only changes CSS and attributes. Video elements are created once per participant and never re-parented. Grid, presentation and whiteboard layouts are CSS states of the same DOM. Changing view, panel or theme never touches `RTCPeerConnection`s, and `browser-test.mjs` asserts this.

### Design system

- The palette is used exactly as specified (Frost, Glacier, Blue Mist, Ink, Crystal), and every color is a token in `tokens.css`.
- **Frost Light** is the default. **Midnight Glass** is opt-in, persisted in `localStorage` and applied by a blocking 6-line script before the stylesheets load.
- The suggested secondary text color `#647B8D` is 3.9:1 on Frost, below WCAG AA for small text. 2.0 uses `#536B7C` (5.0:1) for small text and keeps `#647B8D` as a tertiary token for large or decorative text.
- Glass (`backdrop-filter`) is used only for floating chrome: navigation, toolbars, panels, menus, dialogs and toasts. Video and the whiteboard paper stay opaque. Panels drawn over moving content use the denser surface.
- Fallbacks: browsers without `backdrop-filter`, `prefers-reduced-transparency`, and `prefers-contrast: more` all get near-solid surfaces. `prefers-reduced-motion` disables animation.
- System fonts only, with no remote assets. Icons are an inline SVG sprite.

## 3. Realtime protocol (version 2)

The protocol extends the existing `{ "type": … }` JSON envelope on the single `/ws/rooms` socket. There is no second connection. `join` carries `protocol: 2`. Old clients that omit it still work for calls.

| Client → server | Payload | Server behavior |
| --- | --- | --- |
| `join` | `room, name, device?, resume?` | Validates; resumes identity if the token is valid for this room; replies `joined`. |
| `ping` | — | `pong` |
| `signal` | `to, data` | Relayed only to a member of the sender's room, with server-set `from`. |
| `chat` | `id` (client ID), `text` | Validated and stored, then broadcast as `chat` to the room (sender included). A retried ID is acknowledged to the sender only. |
| `typing` | — | `chat-typing {from, name}` to others (rate-limited, never stored). |
| `board-live` | `id, kind, color, size, points` (delta) | Validated, then relayed as `board-live {from…}` to others. Ephemeral. |
| `board-cursor` | `points:[x,y]` or `hidden:true` | Relayed to others. Ephemeral. |
| `board-add` | `element {id, kind, color, size, points, text?}` | Validated and sequenced, then broadcast as `board-add {seq, element}` (with server-set `author`). A duplicate ID gets `board-ack` to the sender. |
| `board-undo` / `board-redo` | `id` | Only the element's author may do this. Broadcast `{id, seq}`. |
| `board-clear` | — | Clears for everyone. Broadcast `{seq, by, name}`. |
| `board-sync` | — | `board-snapshot {seq, elements}` to the sender. |

`joined` returns `id`, sanitized `name`, `resume`, `peers`, `chat` (recent history), `board` (snapshot), `startedAt`, `now` and `limits`. Errors use `{type:"error", message, code?, ref?}`: `code` is `join`, `chat` or `board`, and `ref` echoes the failed client ID so the UI can mark that exact message or stroke.

### Ordering and late joiners

Every state change is serialized on the handler. A joiner's snapshot is built and sent in the same critical section that adds them to the room. Every later operation is broadcast after it, so a late joiner can't miss or double-apply an operation. Each board change carries `seq`. A client that sees a gap requests `board-sync`, which can only happen through a bug, not by design.

## 4. Chat

- Rendering uses `textContent` only, never `innerHTML`. Text is length-checked (1,000 code points) and normalized on the server: CRLF becomes LF, control and bidi-override characters are removed, and long blank runs are collapsed.
- Sender identity (`from`, `name`) comes from server membership. Message IDs are `participantId-clientId`, so one participant can't suppress another's messages by reusing IDs.
- Messages appear immediately as "sending", are confirmed by the server echo, and fail visibly with **Retry** on rejection or after a 10 s acknowledgement timeout. Messages typed while reconnecting are sent once after rejoining, and server deduplication prevents copies.
- Enter sends, Shift+Enter adds a newline, and IME composition is respected. Send is disabled for empty, whitespace-only or over-limit drafts.
- Unread badge plus toast while chat is closed. Auto-scroll only when the reader is near the bottom; otherwise a "New messages" pill appears.
- Typing indicators are sent at most every 2.5 s and expire after 4 s without a stop signal.

### Retention

| Item | Bound |
| --- | --- |
| History per room | 100 most recent messages (IDs of the last 400 remembered for retry deduplication) |
| Empty-room retention | 15 minutes after the last participant leaves, so a refresh doesn't lose chat or board. Then purged by a 60 s scheduled sweep. |
| Rooms held in memory | 300. When full, the longest-empty room is evicted. Occupied rooms are never evicted. |
| After restart / redeploy | All chat and boards are gone. Nothing is written to disk or a database. |

Chat is not a persistent record. It exists only while the room is active.

## 5. Collaborative whiteboard

- **Coordinates:** points are `x,y` fractions (0–1) of a fixed 16:9 board, quantized to 4 decimals. Brush and text size are thousandths of the board width. Every screen, zoom level and pixel ratio renders the same drawing.
- **Transport:** in-progress strokes stream as throttled `board-live` deltas (every 50 ms, at most 800 values). Finished operations are committed once with `board-add`. Images and full canvases are never sent. Cursors are throttled to every 70 ms.
- **Rendering:** confirmed elements are cached on an offscreen canvas and redrawn only on undo, redo, clear or resize. Each animation frame composites that cache with pending and live strokes. The eraser uses `destination-out` on the ink layer, so the opaque paper shows through.
- **Optimistic drawing:** your stroke appears instantly as pending and is replaced by the server-sequenced copy. Unconfirmed strokes are resent after a reconnect; the server deduplicates by ID.
- **Undo/redo semantics:** each participant's undo stack holds only their own operations. Undo *hides* an element (`seq++`) rather than deleting it, so redo restores it at its original z-position. Concurrent drawings by others are never affected. A stroke still awaiting confirmation can't be undone until it's confirmed. Clear removes everything for everyone and empties redo history. Because the server orders every change and every client applies the same sequence, all boards converge.
- **Permissions:** any room member may clear (there are no host roles in this product). Clear requires a confirmation dialog and is announced to everyone as "*Name* cleared the whiteboard". Undo and redo of another participant's element are refused by the server.
- **Limits:** 2,000 elements and 120,000 coordinate values per board; 4,000 values per stroke (longer strokes are chained automatically); 200 characters of text. When the board is full, undone elements are released first.
- **Export:** PNG at 2560×1440 on white paper.
- **Input:** Pointer Events support mouse, touch and pen. Coalesced events give smooth strokes, and `touch-action: none` applies on the canvas. Shortcuts: P/E/L/R/O/T for tools, Ctrl/⌘+Z to undo, Ctrl/⌘+Shift+Z or Ctrl+Y to redo, Esc to cancel a stroke.

## 6. Security summary

- The server validates every message type and field. Unknown types are rejected and malformed JSON gets an error. Inbound frames are limited to 64 KB, and exceptions are contained per sender.
- Room membership is checked for every non-join message. Signals, chat and board events are scoped to the sender's room. Sender identity and authorship are always server-assigned.
- Per-participant rate limits (token buckets): signaling 400 burst / 100 per s; chat 8 / 1 per s; typing 3 / 0.5 per s; board operations 40 / 15 per s; live strokes and cursors 90 / 45 per s; sync 3 / 0.2 per s.
- Resume tokens are 192-bit random values, valid only in their own room, single-use (rotated on every join), and stored in `sessionStorage` (per tab).
- New room codes have 55 bits of entropy and come from `crypto.getRandomValues` with rejection sampling.
- WebSockets keep Spring's same-origin policy. No secrets reach JavaScript except the TURN credentials that `/api/call-config` already exposed by design.
- No recording, analytics or AI features.

## 7. Scaling beyond one instance

Room state (membership, chat, board, resume tokens) lives in the memory of one JVM, so Render must keep `numInstances: 1`. To scale out later:

1. Route all members of a room to the same instance (consistent hashing on the room code at the proxy), **or**
2. Move room state and fan-out to a shared broker, for example Redis: a hash per room for membership and tokens, a capped list for chat, a stream per board for sequencing, and pub/sub for event delivery. Each instance subscribes to the rooms its sockets belong to.

The per-room `seq` must stay single-writer (Redis `INCR` or a stream ID) to preserve convergence. Media stays peer-to-peer either way. Calls larger than 6 people need an SFU, not more signaling instances.

## 8. Known limitations

- Peer-to-peer mesh: practical for 2–4 people and capped at 6. Mobile CPU and bandwidth are the limit.
- A signaling reconnect renegotiates peer connections, so media pauses briefly (usually 1–2 s).
- Active-speaker detection uses audio levels from Web Audio. It's approximate in noisy rooms and needs the browser to allow an `AudioContext`.
- Undo can't reverse **Clear**, and there's no per-shape selection or move tool.
- Screen sharing remains desktop-oriented. Mobile browsers mostly don't support `getDisplayMedia`.
- Chat and board are lost on restart and expire 15 minutes after a room empties.
- Browser automation used Chrome with synthetic media. Safari, Firefox, real cameras and real phones still need manual checks (see the checklist below).

## 9. Manual multi-device checklist

1. Laptop (Chrome): **Start a meeting**. In the lobby, toggle mic and camera, switch devices, then join.
2. Phone (Safari/Chrome on cellular data with TURN configured): open the invite link and join.
3. Confirm two-way audio and video, mute, camera off/on (camera light turns off), and the speaking ring.
4. Laptop: share a window. The phone shows the presentation layout. Stop sharing.
5. Chat both ways: Enter and Shift+Enter, unread badge, toast, and a long message wraps on the phone.
6. Whiteboard: draw on the phone with a finger and on the laptop with a mouse/pen. Check shapes, text, eraser, undo/redo of only your own work, cursors, and Clear with confirmation.
7. Turn phone Wi-Fi off and on mid-call. The status shows "Reconnecting…", then "Connected". Chat and board are intact.
8. Refresh the laptop tab. It rejoins as the same participant and can still undo its earlier strokes.
9. Export the PNG and open it.
10. Switch to Midnight Glass, reload, and confirm no light flash. Repeat key screens with "Reduce transparency" (macOS/iOS) enabled.
11. Keyboard-only pass: Tab through landing, lobby and toolbar; Esc closes the menu and panel; focus rings are visible.
