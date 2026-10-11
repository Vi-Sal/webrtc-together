# Together 2.0 — Meet. Talk. Create.

A single Spring Boot application serving a plain HTML/CSS/ES-module frontend: group video calls with screen sharing, live chat and a collaborative whiteboard, in the Liquid Glass design (Frost Light and Midnight Glass themes). No Node frontend build, database, account registration, or separate signaling service is required.

Design, protocol, retention and scaling notes: [docs/TOGETHER-2.0.md](docs/TOGETHER-2.0.md).

## Run on your PC

Install JDK 21, then run from this directory:

```bash
./gradlew bootRun --args='--server.port=8081'
```

Open **http://localhost:8081** in a desktop browser and choose **Start a meeting**. Each new meeting gets its own unguessable code (for example `kmrt-vhqa-bzne`). In the lobby, check your camera and microphone, choose devices and enter your name; you can join with either device off. Copy the invite link (link icon in the lobby, or **Invite** in the meeting) and open it in another tab or browser. Use headphones, or mute all but one tab's microphone, to avoid feedback on one PC. If port 8080 is free, plain `./gradlew bootRun` uses 8080 instead.

In the meeting:

- **Share screen** (desktop browsers): camera stays live; several people can share at once and screens take the main stage.
- **Chat**: Enter sends, Shift+Enter adds a line. Unread messages show a badge. New participants receive the last 100 messages.
- **Whiteboard**: pen, eraser, line, rectangle, circle, text, colors, brush size, undo/redo (your own changes), clear (confirmed, for everyone) and PNG export. Video and audio continue while drawing.
- **Leave** stops camera, microphone and screen capture. A refreshed tab rejoins as the same participant; a dropped connection reconnects automatically for up to 90 seconds.

## Package and deploy one application

```bash
./gradlew test bootJar
java -jar build/libs/app.jar --server.port=8081
```

The executable JAR includes the frontend under `src/main/resources/static/`, the REST configuration endpoint, and `/ws/rooms` signaling. Deploy one instance with HTTPS and WebSocket upgrade support. No external frontend assets are loaded.

Camera and screen access work on `localhost`, but **another PC needs an HTTPS address** trusted by its browser. `http://192.168.x.x:8081` is generally not a secure context. Share your deployed HTTPS URL; a localhost invitation only points back to the recipient's own machine. See [MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).

## Connectivity configuration

Same-PC tests work with the default empty ICE server list. For internet calls, configure STUN and a TURN service using environment variables:

```bash
export CALL_STUN_URL='stun:your-stun-host:3478'
export CALL_TURN_URL='turns:your-turn-host:5349'
export CALL_TURN_USERNAME='your-test-user'
export CALL_TURN_PASSWORD='your-test-password'
./gradlew bootRun --args='--server.port=8081'
```

TURN is separate media relay infrastructure, required for reliable connectivity across restrictive networks; Spring Boot does not implement TURN. The browser receives these ICE credentials from `/api/call-config`. Use dedicated, limited test credentials for this anonymous demo. Before opening a public service, replace static TURN credentials with short-lived credentials, add authentication/rate limits and invitation controls. Never use a TURN administration secret here. [WebRTC connectivity documentation](https://webrtc.org/getting-started/peer-connections).

## Scope and architecture

- **Start a meeting** creates a random room; nobody is placed in a shared default room. Existing `?room=CODE` links (including `DEFAULT_NAME`) still work. No accounts, lobby approval, persistent chat or moderation.
- Chat and whiteboard state is held in memory per room (100 messages; bounded board) and expires 15 minutes after the room empties or when the server restarts.
- Six participants maximum per room, using a full peer-to-peer mesh. Each browser sends camera, microphone and optional screen to every other peer. This cap is a guardrail, not a performance guarantee; start with 2–3 users and measure your hardware/network.
- Rooms and membership exist only in memory. Restarting the server ends signaling sessions; multiple app instances need shared routing/state (see the scaling section of the 2.0 notes).
- One WebSocket per participant carries signaling, chat and whiteboard events. The server validates room membership and payloads for every message, assigns participant IDs and authorship itself, rate-limits each participant, and bounds per-session send buffers. WebSockets use Spring's default same-origin policy.
- One deterministic offerer per browser pair establishes three fixed media slots: audio, camera, screen. Track replacement supports simultaneous camera/screen without conflicting offers. An ICE restart is attempted by the offerer on connection failure.
- Media flows between browsers (or through configured TURN), not through Spring. For larger group calls, use an SFU architecture described in `webrtc-guide.html`.

## Files

```text
src/main/java/com/saldev/webrtc/
  config/WebSocketConfig.java            WebSocket registration
  realtime/RoomHandler.java              Transport, membership, signaling and event routing
  realtime/Room*.java, Participant.java  In-memory room state, expiry and rate limits
  service/ChatService.java               Chat validation and bounded history
  service/WhiteboardService.java         Whiteboard validation and editing rules
  controller/CallConfigController.java   Browser ICE configuration
src/main/resources/static/
  index.html                             Landing, lobby and meeting markup
  css/                                   Design tokens, glass surfaces and per-screen styles
  js/core/                               Signaling, media, peer mesh, room codes, theme, chat model
  js/components/                         Landing, lobby, meeting, video tiles, chat, toasts
  js/whiteboard/                         Board model, geometry, canvas renderer and tools
src/test/java/…                          JUnit tests (rooms, chat, whiteboard, services)
src/test/js/frontend.test.mjs            Node unit tests for DOM-free frontend modules
scripts/*.mjs                            Multi-browser Playwright suites
```

## Verification

```bash
./gradlew test
node --test src/test/js/*.test.mjs
node scripts/device-detection-test.mjs
```

Optional browser automation uses Node, Playwright and an installed Chrome. These are test tools only, not deployment dependencies:

```bash
npm install --prefix /tmp/together-browser-test playwright
export PLAYWRIGHT_MODULE=/tmp/together-browser-test/node_modules/playwright/index.mjs
node scripts/browser-test.mjs          # calls, screens, view switching, reconnect, mobile
node scripts/collaboration-test.mjs    # chat, whiteboard, themes, keyboard flows
node scripts/media-fallback-test.mjs   # unavailable/denied devices
node scripts/screen-capture-test.mjs   # screen-share failure modes
node scripts/room-invite-test.mjs      # room codes and invitations
node scripts/heartbeat-test.mjs
node scripts/device-browser-test.mjs
```

Start the app on 8081 first (override with `TEST_URL`; `CHROME_PATH` selects Chrome). The suites use synthetic media and write screenshots under `/tmp/together-*.png`. A real-device test is still needed for webcams, speaker echo, operating-system pickers and TURN connectivity — see the manual checklist in [docs/TOGETHER-2.0.md](docs/TOGETHER-2.0.md).

## Microphone could not start

This browser error can indicate an unavailable audio input, a device held by another app/tab, or an OS/browser capture failure. Close competing calls, select a working input in system/browser settings, and check site permissions. The app requests audio and video independently, so a failed microphone no longer blocks the call. A persistent notice explains the failure; **Retry mic** reacquires it without leaving. For multiple tabs on one PC, uncheck **Start with microphone** in extra tabs to avoid capturing the same input and causing feedback. You may also join with both devices off and still receive media or share your screen.

Run the device-failure regression suite with the same test setup:

```bash
PLAYWRIGHT_MODULE=/tmp/together-browser-test/node_modules/playwright/index.mjs \
  node scripts/media-fallback-test.mjs
```

It simulates unavailable/denied devices and verifies joining, live microphone/camera recovery, and cleanup during a pending device request. Turning the camera off in a meeting stops the camera (its light turns off); turning it on requests it again.

## Screen sharing says “Not supported”

Open the app directly at `http://localhost:8081` in a desktop browser, outside an IDE preview, webview or mobile browser. If the picker offers a browser tab, try that source to distinguish tab capture from desktop capture. A browser may expose `getDisplayMedia` but still reject capture in the current environment. On Linux/Wayland, desktop capture also depends on the desktop's PipeWire/portal integration. Do not disable browser security to work around capture restrictions.

The app requests basic video-only screen capture, then applies optional quality settings. Unsupported quality settings are ignored. The in-call error notice distinguishes **capture** from **publish** failures and includes the browser and exact error under **Details for troubleshooting**. Capture failures leave camera/audio connected. Automated synthetic capture verifies the app's media flow, but does not verify a real operating-system screen picker. See [MDN screen capture documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Run `scripts/screen-capture-test.mjs` with the same `PLAYWRIGHT_MODULE` environment variable as the other browser tests. It checks unsupported capture, cancellation, optional quality-constraint failure, and publication errors while preserving the call.

## Joining the same room

Use **Start a meeting** and share the invitation, or choose **Join a meeting** and enter the code or paste the full link. Both participants must use the same server and port: ports 8080 and 8081 are separate app instances with separate rooms, and links for another server are refused with an explanation.

## Deploy to Render

See [the Render deployment guide](docs/RENDER.md) for Docker Hub build/push commands, Render deployment, TURN settings, and phone acceptance checks. The repository includes `Dockerfile`, `.dockerignore`, and an optional `render.yaml` Blueprint.

See [the testing release review](docs/RELEASE-REVIEW.md) for fixes, validation results, and remaining demo constraints. Run `scripts/heartbeat-test.mjs` with the same Playwright environment to verify signaling keepalive and cleanup.

## Local device-alert testing

Join and leave alerts now include browser-reported device type, OS, browser and model when available. A join keeps the same device snapshot for its leave alert. This is unverified metadata: browsers can hide or spoof it. No device data is broadcast to other room participants.

- Windows/macOS/Linux are detected without claiming an exact OS version.
- Android Client Hints can provide a model code (for example `SM-S938B`); codes are shown as reported, not guessed retail names.
- iPhones/iPads generally do not expose their exact model. Expect `iPhone (exact model unavailable)`, not a guessed `iPhone 16 Pro Max`.
- Device hints start loading in the background on page load. Join never waits for model lookup; missing, blocked or late hints use the available fallback. Telegram delivery stays asynchronous.

See [browser model hints](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues). Published in `docker.io/visal009/together-webrtc:0.4.0` with the 12-hour Telegram timestamp format.

To test actual messages from your PC, use Bash in the repository root:

```bash
read -rsp 'Telegram bot token: ' TELEGRAM_BOT_TOKEN
printf '\n'
export TELEGRAM_BOT_TOKEN
export TELEGRAM_CHAT_ID='-5598350931'
export TELEGRAM_TIME_ZONE='Asia/Phnom_Penh'
./gradlew bootRun --args='--server.port=8081'
```

Open `http://localhost:8081`, start a meeting, join and leave. Confirm both Telegram alerts contain device details. This also sends the existing service-up/stopping alerts. Enter your valid replacement token at the hidden prompt; it is not placed into command history. After stopping with Ctrl+C, run `unset TELEGRAM_BOT_TOKEN` to remove it from that shell's environment.

Automated checks (no real Telegram messages):

```bash
./gradlew test
node scripts/device-detection-test.mjs
PLAYWRIGHT_MODULE=/tmp/together-browser-test/node_modules/playwright/index.mjs \
  node scripts/device-browser-test.mjs
```

The browser test uses simulated device hints in desktop Chrome; physical phone detection and real Telegram delivery still need your confirmation. A phone connecting to your PC's plain LAN HTTP address will not get camera/microphone access; use trusted HTTPS for phone call testing.
