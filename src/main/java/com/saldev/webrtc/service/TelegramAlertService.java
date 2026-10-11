package com.saldev.webrtc.service;

import jakarta.annotation.PreDestroy;
import com.saldev.webrtc.model.DeviceInfo;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

/** Best-effort notifications, isolated from WebSocket signaling. */
@Service
public class TelegramAlertService {
    private static final Logger log = LoggerFactory.getLogger(TelegramAlertService.class);
    private final JsonMapper json = JsonMapper.builder().build();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100), task -> {
                Thread thread = new Thread(task, "telegram-alerts");
                thread.setDaemon(true);
                return thread;
            });
    private final URI endpoint;
    private final String chatId;
    private final DateTimeFormatter timeFormat;

    @Autowired
    public TelegramAlertService(
            @Value("${telegram.bot-token:}") String token,
            @Value("${telegram.chat-id:}") String chatId,
            @Value("${telegram.time-zone:Asia/Phnom_Penh}") String timeZone) {
        this(endpoint(token, chatId), chatId, ZoneId.of(timeZone));
    }

    TelegramAlertService(URI endpoint, String chatId, ZoneId zone) {
        this.endpoint = endpoint;
        this.chatId = chatId;
        timeFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd h:mm:ss a", Locale.ENGLISH).withZone(zone);
    }

    private static URI endpoint(String token, String chatId) {
        if (token.isBlank() != chatId.isBlank()) {
            throw new IllegalArgumentException("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID together, or leave both empty.");
        }
        if (token.isBlank()) return null;
        if (!token.matches("[0-9]+:[A-Za-z0-9_-]+") || !chatId.matches("-?[0-9]+")) {
            throw new IllegalArgumentException("Invalid Telegram bot token or numeric chat ID configuration.");
        }
        return URI.create("https://api.telegram.org/bot" + token + "/sendMessage");
    }

    public void joined(String name, String room, Instant at, int participants) {
        joined(name, room, at, participants, DeviceInfo.unknown());
    }

    public void joined(String name, String room, Instant at, int participants, DeviceInfo device) {
        enqueue("🟢 Participant joined\n" + details(name, room, at) + device.alertText()
                + "\nIn room now: " + participants
                + "\n" + clean(name) + " joined the call."
                + (participants == 1 ? " Waiting for others to join." : " The conversation can continue together."));
    }

    public void left(String name, String room, Instant at, Instant joinedAt, int remaining) {
        left(name, room, at, joinedAt, remaining, DeviceInfo.unknown());
    }

    public void left(String name, String room, Instant at, Instant joinedAt, int remaining, DeviceInfo device) {
        long seconds = Math.max(0, Duration.between(joinedAt, at).getSeconds());
        enqueue("🔴 Participant left / disconnected\n" + details(name, room, at) + device.alertText()
                + "\nTime in room: " + seconds / 60 + "m " + seconds % 60 + "s"
                + "\nRemaining: " + remaining
                + "\n" + clean(name) + " is no longer in the call."
                + (remaining == 0 ? " The room is now empty." : " Other participants are still in the room."));
    }

    public void serviceUp(String service, String instance, Instant at) {
        enqueue("🟢 Service up\nService: " + clean(service) + "\nInstance: " + clean(instance)
                + "\nTime: " + timeFormat.format(at)
                + "\nThe application has finished starting and is ready to accept calls."
                + " This may be a wake-up, restart, or new deployment; public reachability is not checked.");
    }

    public void serviceStopping(String service, String instance, Instant at, Instant startedAt) {
        if (endpoint == null) return;
        // Prioritize the final lifecycle notice over queued membership notifications.
        worker.shutdownNow();
        try {
            worker.awaitTermination(1, TimeUnit.SECONDS);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return;
        }
        long seconds = Math.max(0, Duration.between(startedAt, at).getSeconds());
        // Send synchronously with the HTTP timeout before Spring destroys this client.
        deliver("🟠 Service stopping\nService: " + clean(service) + "\nInstance: " + clean(instance)
                + "\nTime: " + timeFormat.format(at)
                + "\nUptime since ready: " + seconds / 3600 + "h " + seconds / 60 % 60 + "m " + seconds % 60 + "s"
                + "\nThis instance is shutting down. Possible reasons: idle sleep, restart, redeploy, or manual stop."
                + " The application cannot confirm the reason. This is not confirmation that the whole service is offline."
                + "\nIf Render puts the service to sleep, opening its URL will request a wake-up.");
    }

    private String details(String name, String room, Instant at) {
        return "Username: " + clean(name) + "\nGroup / room: " + clean(room) + "\nTime: " + timeFormat.format(at);
    }

    private static String clean(String value) {
        // Keep untrusted display names on one line. No HTML or Markdown parsing is enabled.
        return value.replaceAll("[\\p{Cntrl}\\p{Cf}\\p{Zl}\\p{Zp}]", " ");
    }

    private void enqueue(String text) {
        if (endpoint == null) return;
        try {
            worker.execute(() -> deliver(text));
        } catch (RejectedExecutionException exception) {
            log.warn("Telegram alert dropped: notification queue is full or shutting down.");
        }
    }

    private void deliver(String text) {
        try {
            var request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(8))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of(
                            "chat_id", chatId, "text", text, "link_preview_options", Map.of("is_disabled", true)))))
                    .build();
            var response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200 || !json.readTree(response.body()).path("ok").asBoolean()) {
                log.warn("Telegram alert was not delivered (HTTP {}). Check bot membership, permissions and configuration.", response.statusCode());
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        } catch (Exception exception) {
            // Exception messages and request URLs can contain the bot token; never log them.
            log.warn("Telegram alert delivery failed; the call is unaffected.");
        }
    }

    @PreDestroy
    public void close() {
        worker.shutdownNow();
        client.shutdownNow();
    }
}
