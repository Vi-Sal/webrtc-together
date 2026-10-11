# Deploy Together to Render

Published testing image: `docker.io/visal009/together-webrtc:0.5.1` (2026-10-09). Select this reference under **Existing Image** in Render. The image passed container smoke checks; a live Render deployment and physical-phone call still need verification.

## Docker Hub → Render (recommended for your test)

Run these commands from the repository root on a machine with Docker running. Replace `YOUR_DOCKERHUB_USERNAME` with your Docker Hub account and create a `together-webrtc` repository there. Use a new version tag for each release.

```bash
export DOCKERHUB_USERNAME=YOUR_DOCKERHUB_USERNAME
export IMAGE="docker.io/${DOCKERHUB_USERNAME}/together-webrtc:0.1.0"
docker buildx build --platform linux/amd64 --load -t "$IMAGE" .
docker run --rm --name together-webrtc -p 10000:10000 "$IMAGE"
```

The build runs the Java tests. In a second terminal, check `curl --fail http://localhost:10000/healthz` and open `http://localhost:10000`. Stop the container with Ctrl+C when finished. Then push from the original terminal:

```bash
docker login --username "$DOCKERHUB_USERNAME"
docker push "$IMAGE"
```

Enter a Docker Hub access token at the login prompt; never put it in the Dockerfile or build arguments. TURN settings are runtime environment variables, not image contents.

1. In Render choose **New → Web Service → Existing Image**.
2. Enter `docker.io/YOUR_DOCKERHUB_USERNAME/together-webrtc:0.1.0`. For a private repository, add a registry credential that can pull the image.
3. Choose your project/environment, Singapore (or your preferred region), and Free for testing. Keep **one instance**.
4. Set `PORT=10000`, health check `/healthz`, and your `CALL_STUN_URL` / `CALL_TURN_*` variables below. Leave the Docker command override empty.
5. Deploy, wait for health checks, and open the assigned `https://...onrender.com` address.
6. On updates, push a new version tag and update the image reference. If reusing a tag, use **Manual Deploy → Deploy latest reference**; pushing to Docker Hub alone does not redeploy Render.

Render requires `linux/amd64` images. This is why the build command specifies the platform, including on Apple Silicon. See [Render prebuilt image deployment](https://render.com/docs/deploying-an-image).

### Phone acceptance check

- Open the Render **HTTPS** URL directly in the phone browser; allow microphone/camera access.
- Copy the invitation from your laptop and open it on the phone. Confirm both use the exact same server and room.
- Test first on Wi-Fi, then turn phone Wi-Fi off and repeat on mobile data with working TURN credentials.
- Check two-way audio/video, mute, camera toggle, leave/rejoin, and receiving a desktop screen share. Use headphones to avoid feedback.
- Keep the phone browser in the foreground; locking the phone or switching apps can suspend media and timers. Rejoin if disconnected. Screen capture availability depends on the mobile browser.
- Leave a foreground call running beyond 15 minutes. Joined clients send a signaling heartbeat every 25 seconds so an active foreground call continues sending traffic; unused free services can still sleep.

See [Render free-service idle behavior](https://render.com/docs/free). A successful local test does not prove cellular TURN connectivity.

## What is prepared

- `Dockerfile` builds and tests Java 21 sources and packages the static frontend inside the executable JAR. Its runtime uses a non-root user.
- `render.yaml` offers a single-instance, free-plan Docker web service in Singapore, with automatic redeploys disabled. It does not itself identify or attach to the existing project.
- Spring listens on `0.0.0.0` and Render's `PORT`, with a local default of 8080. Proxy forwarding support preserves the public HTTPS origin for WebSocket handshakes.
- `GET /healthz` returns `{"status":"UP"}` without exposing ICE credentials.

## Alternative: deploy from a Git repository

1. Push this directory to a GitHub/GitLab repository that Render can access. Include `gradlew`, `gradle/wrapper/`, `src/`, build files, and deployment files. Do not upload `build/`, local environment files or credentials.
2. Open your target Render project and create a **Web Service**, connecting that repository. Choose the intended project environment. If creation does not offer project selection, move the resulting service into this project's environment from the dashboard.
3. Set the following values:

| Setting | Value |
| --- | --- |
| Service name | `together-webrtc` (or another available name) |
| Runtime | Docker |
| Dockerfile path | `./Dockerfile` |
| Docker context | Repository root |
| Root directory | Empty, if these files are at repository root |
| Region | Singapore, or your preferred region |
| Instance plan | Free for an initial demo |
| Instance count | 1 |
| Health check path | `/healthz` |
| Environment | `PORT=10000` |
| Auto-deploy | Off; deploy updates manually |

Leave custom build/start commands unset: the Dockerfile handles both. Select **Deploy Web Service** and wait for a successful build and health check. Alternatively, create a Blueprint from `render.yaml`, then verify its project/environment assignment. See [Render web services](https://render.com/docs/web-services) and [Blueprint configuration](https://render.com/docs/blueprint-spec).

## Configure internet call connectivity

The web service hosts the UI and signaling. It does not provide a TURN relay. Add these values in the service's **Environment** settings using your STUN/TURN provider:

| Environment variable | Value |
| --- | --- |
| `CALL_STUN_URL` | Provider STUN URL, e.g. `stun:stun.example.com:3478` |
| `CALL_TURN_URL` | Provider TURN URL, e.g. `turns:turn.example.com:443?transport=tcp` |
| `CALL_TURN_USERNAME` | Provider-issued client username |
| `CALL_TURN_PASSWORD` | Provider-issued client credential |

These are examples, not working relay addresses. Leave them unset only for initial UI/signaling validation or networks that support direct peer connections. For reliable calls between different networks, configure a working relay; STUN alone cannot solve every connection failure. [WebRTC connectivity guide](https://webrtc.org/getting-started/peer-connections).

This anonymous demo exposes the configured TURN client credentials to room clients through `/api/call-config`. Use restricted demo credentials and quotas, never a provider administration secret. A public production service needs authenticated, short-lived TURN credentials. `DEFAULT_NAME` is a shared public room, not an access-controlled private meeting.

## Verify after deployment

1. Open the actual HTTPS service URL Render assigns, then `/healthz`; expect status `UP`.
2. Join with an empty room field. Open the same service URL on another browser/device and join `DEFAULT_NAME`.
3. Verify both names appear, then test video, microphone, and two simultaneous screen shares.
4. Confirm `/ws/rooms` upgrades successfully using `wss://` in the browser Network panel. The app chooses WSS automatically on HTTPS.
5. Test separate networks (for example home Wi-Fi and mobile data) with the TURN configuration. Same-PC success alone does not verify public network connectivity.

Render provides HTTPS and WebSocket support. Deployments replace instances and close their connections, so existing users must rejoin. Keep one instance because this application's rooms are in memory. [Render WebSockets](https://render.com/docs/websocket).

The free plan can spin down after inactivity and takes time to wake up; use it as a demo, not an always-on calling service. Review limits before selecting a paid plan. [Render free-service limits](https://render.com/docs/free).

## Local deployment smoke test

```bash
./gradlew test bootJar
PORT=10000 java -jar build/libs/app.jar
curl http://localhost:10000/healthz
python3 scripts/deployment-smoke-test.py
```

If Docker is installed:

```bash
docker build -t together-webrtc .
docker run --rm -p 10000:10000 together-webrtc
```

Prepared files are not evidence of a live deployment. A successful Render deploy and the assigned public service URL must be verified separately.

## Telegram join/leave alerts (image 0.2.0)

Add your bot to the destination Telegram group and allow it to send messages. Under Render **Environment**, set:

| Key | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Your replacement BotFather token; keep it secret |
| `TELEGRAM_CHAT_ID` | `-5598350931` |
| `TELEGRAM_TIME_ZONE` | `Asia/Phnom_Penh` (default) |

Use published image `docker.io/visal009/together-webrtc:0.2.0`, then redeploy. Both token and chat ID must be configured together. Leave both unset to disable alerts. Tokens are server-side runtime configuration: never put them in the frontend, Dockerfile, image, or repository. Revoke any token previously shared in chat.

Example join alert:

```text
🟢 Participant joined
Username: Visal
Group / room: DEFAULT_NAME
Time: 2026-10-09 9:00:00 PM
In room now: 1
Visal joined the call. Waiting for others to join.
```

Leave alerts also show the duration and remaining participant count. “Username” is the unverified display name typed in the app; “Group / room” is the call's room code, not the Telegram destination group's title. Leaving, closing a tab, and a server-detected disconnection produce the same leave alert; detection can lag when a phone loses its network. Duplicate joins and rejected joins do not generate membership alerts.

Messages use Telegram's [sendMessage API](https://core.telegram.org/bots/api#sendmessage). Delivery is best-effort, ordered through one worker with a maximum of 100 queued notifications and bounded HTTP timeouts. Network errors, rate limits and full queues are logged without tokens; failed deliveries are not retried. Queued alerts can be lost on shutdown/restart. Calls continue independently of Telegram delivery. This is not a durable attendance log.

To verify: join a unique room on the deployed app, check the Telegram join alert, then click **Leave** and check the duration and remaining count. If nothing arrives, inspect Render logs and confirm the bot is a member allowed to post in the configured group.

## Service up and stopping alerts (image 0.3.0)

The same Telegram settings now also enable:

- **Service up** when Spring has finished starting, including service name, instance ID and Cambodia time. This is application readiness, not an external check of the public URL. Wake-up, redeploy and restart all produce this message.
- **Service stopping** when a ready application receives a normal shutdown, including instance ID, time and uptime. The message states that idle sleep, restart, redeploy or manual stop are possible reasons. It does not claim that Render has confirmed sleep or that all instances are offline.

No extra environment variables are required. `RENDER_INSTANCE_ID` identifies the Render instance; local runs use a generated ID. The shutdown alert is prioritized over queued membership messages, which may be discarded. It has an eight-second HTTP timeout, plus at most one second waiting for the notification worker. Application graceful shutdown is limited to ten seconds per phase to leave time within Render's usual shutdown window. Delivery remains best-effort.

Render Free services spin down after 15 minutes without inbound HTTP requests or WebSocket messages. The existing 25-second heartbeat keeps foreground calls sending traffic; empty rooms do not send it. A sleeping service wakes on a new request or WebSocket connection. See [Render Free services](https://render.com/docs/free) and [Render shutdown behavior](https://render.com/docs/deploys).

A process cannot send an alert after it is already asleep or abruptly killed. Crashes, forced termination, loss of network access and failed startup may produce no stopping alert. Exact sleep confirmation or reliable outage detection requires an independent platform-event integration or external monitor. Regularly polling the app's URL would itself generate traffic and can prevent idle sleep.

After deploying image `docker.io/visal009/together-webrtc:0.3.0`, check for an up alert. Redeploy once to exercise normal shutdown and startup; use instance IDs to distinguish the old and new instances. To observe idle behavior, close the call tabs and avoid requesting the URL for more than 15 minutes. A stopping alert, if delivered, reports shutdown rather than a proven sleep reason. Then open the URL and look for the new up alert.

All Telegram event timestamps use `yyyy-MM-dd h:mm:ss a`, for example `2026-10-09 9:50:49 PM`. The configured time zone still applies (Cambodia by default); the zone suffix is omitted.

## Device and time-format release 0.4.0

Update the Render image reference to `docker.io/visal009/together-webrtc:0.4.0` and redeploy. Existing Telegram settings are unchanged. This release includes optional browser-reported device details in join/leave alerts and 12-hour timestamps such as `2026-10-09 9:50:49 PM`. Exact phone models are only included when exposed by the browser.

## Scheduled health request (corrected in 0.5.1)

Spring schedules `GET /healthz` five minutes after startup and every five minutes after each completed request. When the embedded server starts, the scheduler chooses its target:

- On Render, it uses `RENDER_EXTERNAL_URL`, which [Render supplies automatically](https://render.com/docs/environment-variables). For this service the log should show `https://together-webrtc.onrender.com/healthz`. You do not add this variable in the dashboard.
- Outside Render, it uses `http://localhost:<actual-listening-port>/healthz`, including when the port is assigned dynamically. No Render-specific configuration is needed to move the app to another platform, though a platform's own public URL cannot always be discovered automatically.

The request has a ten-second timeout; failures are logged without affecting calls. `health-ping.interval-ms=300000` controls the initial and repeat delays. This is an in-process timer, so it cannot wake a Render instance after the Free service sleeps. A public request while the instance is running may count as inbound traffic, but this behavior is not a reliable uptime guarantee. For dependable external monitoring or waking a sleeping service, use a scheduler outside the app.
