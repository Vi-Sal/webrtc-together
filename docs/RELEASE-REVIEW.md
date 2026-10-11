# Testing release review

Reviewed the signaling handler, browser media lifecycle, ICE configuration endpoint, Docker packaging, and Render settings. Suitable for a small, single-instance demo after the deployment and phone checks below; this is not a production security audit.

## Fixed

- Foreground calls now send a heartbeat every 25 seconds. Media travels outside Spring, so an otherwise active call could produce no signaling traffic and allow a free Render service to idle. Leaving clears both heartbeat and join timers.
- Non-object/empty signaling payloads are explicitly rejected; regression tests confirm the session remains usable.
- ICE configuration uses constructor injection and an immutable server list. Incomplete TURN credential sets fail at startup rather than silently producing unusable relay settings. Responses use `Cache-Control: no-store`.
- Configuration fetches have a 15-second timeout rather than leaving the join form waiting indefinitely.
- Docker copies a deterministic `app.jar`; the existing multi-stage Java 21 build runs tests and retains its non-root runtime.
- The deployment guide now covers Docker Hub, explicit `linux/amd64` builds, image-backed Render deployment, and phone checks. Removed the stale hard-coded Render project reference.

## Validation completed

- `./gradlew --no-daemon test bootJar`: passed, 10 Java tests.
- `node --check src/main/resources/static/app.js`: passed.
- Packaged application smoke test: health, frontend, HTTPS-forwarded WebSocket upgrade, and cross-origin rejection passed.
- Playwright suites: `browser-test.mjs`, `media-fallback-test.mjs`, `screen-capture-test.mjs`, `room-invite-test.mjs`, and `heartbeat-test.mjs` passed against the packaged application.
- Browser tests use synthetic media and desktop Chrome (including mobile viewport layout), not a physical phone.

## Required before phone acceptance

Follow [RENDER.md](RENDER.md). On 2026-10-09, the `linux/amd64` image was built with tests passing and pushed to `docker.io/visal009/together-webrtc:0.1.0`. Its Docker Hub manifest was verified. Container smoke checks passed with a 512 MB memory limit and non-root user `10001:10001`. Release digest: `sha256:97c297fb65d0a7eaadbdbaa007d87cd0245ce2923c719c021bf36ad46661e319`. A live Render deployment and actual phone call remain unverified. Configure provider-issued TURN client credentials and test laptop Wi-Fi against phone cellular data. Empty ICE configuration is only useful on networks that permit direct connections.

## Remaining demo constraints

- Anonymous rooms, including the shared `DEFAULT_NAME`, have no authentication or admission controls. Anyone who knows a room code can join up to its six-person limit.
- TURN client credentials are intentionally delivered to browsers. Use limited demo credentials and provider quotas. Public production use needs authenticated, short-lived credentials and abuse controls.
- Keep one instance: room state is in memory. Restart/deploy closes calls; users must rejoin.
- Signaling handlers serialize operations globally and send synchronously. This is a small-demo implementation, not a tested high-concurrency server; production scaling needs bounded outbound queues, admission/rate limits, and shared room routing.
- Six participants use a full mesh and can overload phone bandwidth or CPU. Begin with two participants. Mobile background suspension and desktop-only screen capture support depend on the browser; the heartbeat cannot prevent OS suspension.

## Telegram release 0.2.0 (2026-10-09)

Added asynchronous, server-side join/leave notifications with display name, room code, Cambodia time, membership counts and session duration. Telegram credentials come only from environment variables. Delivery is best-effort and bounded; see the deployment guide for setup and limitations.

Validation: 13 Java tests passed locally and during the Docker build, including mock Telegram HTTP delivery/failure checks and membership event tests. Container smoke checks passed with a 512 MB limit. Published `docker.io/visal009/together-webrtc:0.2.0` and verified its registry manifest. Digest: `sha256:ad5eb802de11aa095ec273b0d797aa3b0c017950f688d61b49c4d8c9e8c1a952`. No live Telegram message or Render redeployment was performed; the replacement bot token must be configured in Render.

## Lifecycle release 0.3.0 (2026-10-09)

Added ready and stopping Telegram alerts, with service name, instance ID, local time and uptime. Shutdown prioritizes its final notice with bounded synchronous delivery before the HTTP client is destroyed. It cannot confirm idle sleep versus another shutdown reason, or report after abrupt termination. Join/leave messages continue to use a bounded background worker; no HTTP request is performed on the room handler thread.

Validation: 17 local Java tests passed, including Spring lifecycle event wiring, duplicate suppression, shutdown HTTP delivery and a slow-server test demonstrating join/leave return while Telegram is blocked. The Docker build also passed its tests (the final test-only addition ran locally after the build context was captured). Container health/frontend/proxy WebSocket checks passed. Published and verified `docker.io/visal009/together-webrtc:0.3.0`, digest `sha256:4a570c90434e12a2d22e9081b155acc85e60bb75c35214f759673cff2eb1fe83`. Live Render lifecycle behavior and real Telegram delivery are not yet verified.

## Unpublished local device-alert change

Added browser-reported device type, OS, browser and optional model to join/leave Telegram messages. Model hints are requested in the background; joining uses an immediate snapshot and never waits for them. Device fields are length-limited and stripped of control characters on the server, retained for the leave alert, and excluded from peer broadcasts. Missing metadata remains compatible with older clients.

Validation: 19 Java tests passed; JavaScript detection fixtures and real-browser WebSocket joins passed, including an indefinitely pending model-hint request. Local packaged-app deployment smoke checks passed. Phone models in browser tests were simulated; real device accuracy and live Telegram messages await local user confirmation. No Docker image was built or pushed for this change.

## Device and timestamp release 0.4.0 (2026-10-09)

Published the previously local device metadata changes and `yyyy-MM-dd h:mm:ss a` Telegram timestamps after user approval. The configured timezone remains unchanged. Docker's Java test/build step, JavaScript device fixtures, container health/proxy WebSocket checks and browser device-signaling checks passed. Runtime tested under a 512 MB memory limit, platform linux/amd64, user 10001:10001.

Published and verified `docker.io/visal009/together-webrtc:0.4.0`. Digest: `sha256:de7c3f6e3e3e0bc10e833a07281e6a565577a894774c9bc3690d68641b8a2a36`. Render redeployment and real Telegram/phone checks remain separate.

## Unpublished scheduled health request

Added a Spring scheduler that derives the local `/healthz` URL from the actual listening port on a five-minute fixed delay after an initial five-minute delay, with a ten-second request timeout. Local Java tests, including a simulated unhealthy response, and `bootJar` passed. Since the timer lives inside the app, it stops when Render stops the app; it cannot reliably wake a sleeping instance or guarantee uptime. No new image has been pushed for this change.

## Portable health scheduler release 0.5.0 (2026-10-10)

Published `docker.io/visal009/together-webrtc:0.5.0`, digest `sha256:751f201a628110d6bcebed233be271973524ccceaef4126fad550800f18871b7`. The five-minute scheduler derives `http://localhost:<actual-port>/healthz` after web-server startup; it needs no hosted URL or platform variable. Docker build tests, container HTTP/WebSocket smoke checks, and registry manifest verification passed. In the test container the scheduler logged `http://localhost:10000/healthz`. This local self-request does not traverse Render's public ingress and cannot prevent Free instance sleep.

## Public URL scheduler correction (2026-10-10)

The 0.5.0 image logs `http://localhost:10000/healthz` on Render because it uses the container listener. This correction uses Render's automatically provided `RENDER_EXTERNAL_URL` when present, and the dynamic local port elsewhere. No dashboard variable is required. Java tests cover both target choices. A new image is needed to replace 0.5.0 on Render.

## Corrected Render URL release 0.5.1 (2026-10-10)

Published `docker.io/visal009/together-webrtc:0.5.1`, digest `sha256:716679639336a62243f024ee4c328808d01b827d7ce8c380f31eebbbf1a50007`. Tests and container smoke checks passed. With Render's automatically supplied `RENDER_EXTERNAL_URL` simulated, the image logged `https://together-webrtc.onrender.com/healthz`; no manual dashboard variable is needed. Outside Render it falls back to the actual local port. Registry manifest verified. Render must be redeployed to use the corrected image.
