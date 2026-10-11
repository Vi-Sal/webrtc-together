# Together — Spring Boot group calls

A single Spring Boot application serving plain HTML, CSS and JavaScript. No Node frontend build, database, account registration, or separate signaling service is required.

## Run on your PC

Install JDK 21, then run from this directory:

```bash
./gradlew bootRun --args='--server.port=8081'
```

Open **http://localhost:8081** in a desktop browser. Enter your name, choose whether to start with microphone/camera, and allow access to the selected devices. If a device cannot start, you still join with the available devices. Use **Retry mic** or **Retry camera** after fixing its permissions or availability. Click **Copy invite link**, then open that exact link in another tab or browser and join with another name. Use headphones, or mute all but one tab's microphone, to avoid feedback on one PC. If another application is not using port 8080, plain `./gradlew bootRun` uses 8080 instead.

Click **Share screen** and choose a window, tab, or display in the browser picker. Camera video stays visible. Other participants can share simultaneously; each screen has a separate tile. This version shares screen video only, not system audio. Screen capture support varies on mobile; desktop Chrome/Edge/Firefox is the intended starting point.

**Leave call** stops camera, microphone and screen capture. A closed or refreshed tab is removed from the room. If the signaling server disconnects, the app releases media and offers the join form again.

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

- Empty room fields join the shared `DEFAULT_NAME` room. Custom room codes and invitation links are also supported; no accounts, lobby approval, persistent chat or moderation.
- Six participants maximum per room, using a full peer-to-peer mesh. Each browser sends camera, microphone and optional screen to every other peer. This cap is a guardrail, not a performance guarantee; start with 2–3 users and measure your hardware/network.
- Rooms and membership exist only in memory. Restarting the server ends signaling sessions; multiple app instances need shared routing/state.
- The server validates room membership before forwarding signals and derives sender IDs from the socket session. WebSockets use Spring's default same-origin policy.
- One deterministic offerer per browser pair establishes three fixed media slots: audio, camera, screen. Track replacement supports simultaneous camera/screen without conflicting offers. An ICE restart is attempted by the offerer on connection failure.
- Media flows between browsers (or through configured TURN), not through Spring. For larger group calls, use an SFU architecture described in `webrtc-guide.html`.

## Files

```text
src/main/java/com/saldev/webrtc/
  config/WebSocketConfig.java          WebSocket registration
  realtime/RoomHandler.java            Membership and signaling
  controller/CallConfigController.java Browser ICE configuration
src/main/resources/static/
  index.html                          Lobby and room UI
  style.css                           Responsive styling
  app.js                              Media and call lifecycle
src/test/java/com/saldev/webrtc/realtime/RoomHandlerTests.java
scripts/browser-test.mjs               Multi-browser media checks
```

## Verification

```bash
./gradlew test
node --check src/main/resources/static/app.js
```

Optional browser automation uses Node, Playwright and an installed Chrome. These are test tools only, not deployment dependencies:

```bash
npm install --prefix /tmp/together-browser-test playwright
PLAYWRIGHT_MODULE=/tmp/together-browser-test/node_modules/playwright/index.mjs \
  node scripts/browser-test.mjs
```

Start the app on 8081 before running this script. Override `TEST_URL` and `CHROME_PATH` if needed. The script uses synthetic media to check three-person audio/video, mute/camera state, two simultaneous screen shares, late arrival, screen restart, leave cleanup and mobile layout. Screenshots are written under `/tmp/together-*.png`. A real-device test is still needed to check your webcam, speaker echo, operating-system picker, and external-network TURN connectivity.

## Microphone could not start

This browser error can indicate an unavailable audio input, a device held by another app/tab, or an OS/browser capture failure. Close competing calls, select a working input in system/browser settings, and check site permissions. The app requests audio and video independently, so a failed microphone no longer blocks the call. A persistent notice explains the failure; **Retry mic** reacquires it without leaving. For multiple tabs on one PC, uncheck **Start with microphone** in extra tabs to avoid capturing the same input and causing feedback. You may also join with both devices off and still receive media or share your screen.

Run the device-failure regression suite with the same test setup:

```bash
PLAYWRIGHT_MODULE=/tmp/together-browser-test/node_modules/playwright/index.mjs \
  node scripts/media-fallback-test.mjs
```

It simulates unavailable/denied devices and verifies joining, live microphone/camera recovery, and cleanup during a pending device request.

## Screen sharing says “Not supported”

Open the app directly at `http://localhost:8081` in a desktop browser, outside an IDE preview, webview or mobile browser. If the picker offers a browser tab, try that source to distinguish tab capture from desktop capture. A browser may expose `getDisplayMedia` but still reject capture in the current environment. On Linux/Wayland, desktop capture also depends on the desktop's PipeWire/portal integration. Do not disable browser security to work around capture restrictions.

The app requests basic video-only screen capture, then applies optional quality settings. Unsupported quality settings are ignored. The in-call error notice distinguishes **capture** from **publish** failures and includes the browser and exact error under **Details for troubleshooting**. Capture failures leave camera/audio connected. Automated synthetic capture verifies the app's media flow, but does not verify a real operating-system screen picker. See [MDN screen capture documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Run `scripts/screen-capture-test.mjs` with the same `PLAYWRIGHT_MODULE` environment variable as the other browser tests. It checks unsupported capture, cancellation, optional quality-constraint failure, and publication errors while preserving the call.

## Joining the same room

Leave **Room code or invitation link** empty to join `DEFAULT_NAME`. Empty and whitespace-only values use this same shared room, so two people opening the home page on the same server meet automatically. Enter a custom room code or paste an invitation to join another room.

Both participants must use the same server and port. Ports 8080 and 8081 are separate app instances with separate membership. The call displays its room code and server address for comparison.

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

Open `http://localhost:8081`, enter a name, join a room and leave. Confirm both Telegram alerts contain device details. This also sends the existing service-up/stopping alerts. Enter your valid replacement token at the hidden prompt; it is not placed into command history. After stopping with Ctrl+C, run `unset TELEGRAM_BOT_TOKEN` to remove it from that shell's environment.

Automated checks (no real Telegram messages):

```bash
./gradlew test
node scripts/device-detection-test.mjs
PLAYWRIGHT_MODULE=/tmp/together-browser-test/node_modules/playwright/index.mjs \
  node scripts/device-browser-test.mjs
```

The browser test uses simulated device hints in desktop Chrome; physical phone detection and real Telegram delivery still need your confirmation. A phone connecting to your PC's plain LAN HTTP address will not get camera/microphone access; use trusted HTTPS for phone call testing.
