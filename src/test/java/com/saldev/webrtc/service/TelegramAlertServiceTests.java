package com.saldev.webrtc.service;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.time.ZoneId;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

class TelegramAlertServiceTests {
    @Test
    void sendsOrderedPlainTextMessagesAndContinuesAfterTelegramFailure() throws Exception {
        var messages = new LinkedBlockingQueue<JsonNode>();
        var json = JsonMapper.builder().build();
        var calls = new AtomicInteger();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/sendMessage", exchange -> {
            messages.add(json.readTree(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
            boolean first = calls.getAndIncrement() == 0;
            byte[] body = (first ? "{\"ok\":false}" : "{\"ok\":true}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(first ? 429 : 200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        var alerts = new TelegramAlertService(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/sendMessage"),
                "-123", ZoneId.of("Asia/Phnom_Penh"));
        try {
            Instant joinedAt = Instant.parse("2026-10-09T12:00:00Z");
            alerts.joined("<Visal>\nAdmin", "test-room", joinedAt, 1,
                    new com.saldev.webrtc.model.DeviceInfo("Phone", "Android", "Chrome", "SM-S938B\nInjected"));
            alerts.left("<Visal>\nAdmin", "test-room", joinedAt.plusSeconds(125), joinedAt, 0);
            JsonNode joined = messages.poll(5, TimeUnit.SECONDS);
            JsonNode left = messages.poll(5, TimeUnit.SECONDS);
            assertNotNull(joined);
            assertNotNull(left);
            assertEquals("-123", joined.path("chat_id").asText());
            assertFalse(joined.has("parse_mode"));
            String text = joined.path("text").asText();
            assertTrue(text.contains("Username: <Visal> Admin\nGroup / room: test-room"));
            assertTrue(text.contains("2026-10-09 7:00:00 PM"));
            assertTrue(text.contains("In room now: 1"));
            assertTrue(text.contains("Device (browser-reported): Phone\nOS: Android\nBrowser: Chrome\nModel: SM-S938B Injected"));
            assertTrue(left.path("text").asText().contains("Time in room: 2m 5s"));
            assertTrue(left.path("text").asText().contains("The room is now empty."));
        } finally {
            alerts.close();
            server.stop(0);
        }
    }

    @Test
    void stoppingNoticeIsDeliveredBeforeClientDestruction() throws Exception {
        var messages = new LinkedBlockingQueue<JsonNode>();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/sendMessage", exchange -> {
            messages.add(JsonMapper.builder().build().readTree(
                    new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
            byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        var alerts = new TelegramAlertService(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/sendMessage"),
                "-123", ZoneId.of("Asia/Phnom_Penh"));
        try {
            Instant ready = Instant.parse("2026-10-09T12:00:00Z");
            alerts.serviceUp("webrtc", "instance-1", ready);
            JsonNode up = messages.poll(5, TimeUnit.SECONDS);
            assertNotNull(up);
            assertTrue(up.path("text").asText().contains("Service up"));
            assertTrue(up.path("text").asText().contains("Instance: instance-1"));
            alerts.serviceStopping("webrtc", "instance-1", ready.plusSeconds(3661), ready);
            alerts.close();
            JsonNode stopping = messages.poll();
            assertNotNull(stopping, "Final alert must reach the endpoint before shutdown returns");
            String text = stopping.path("text").asText();
            assertTrue(text.contains("Service stopping"));
            assertTrue(text.contains("Uptime since ready: 1h 1m 1s"));
            assertTrue(text.contains("2026-10-09 8:01:01 PM"));
            assertTrue(text.contains("cannot confirm the reason"));
        } finally {
            alerts.close();
            server.stop(0);
        }
    }

    @Test
    void slowTelegramDoesNotBlockJoinOrLeave() throws Exception {
        var requestStarted = new CountDownLatch(1);
        var allowResponse = new CountDownLatch(1);
        var bothDelivered = new CountDownLatch(2);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/sendMessage", exchange -> {
            exchange.getRequestBody().readAllBytes();
            requestStarted.countDown();
            try {
                allowResponse.await(5, TimeUnit.SECONDS);
                byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
                bothDelivered.countDown();
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            } finally { exchange.close(); }
        });
        server.start();
        var alerts = new TelegramAlertService(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/sendMessage"),
                "-123", ZoneId.of("Asia/Phnom_Penh"));
        try {
            Instant now = Instant.now();
            assertTimeoutPreemptively(Duration.ofSeconds(1), () -> alerts.joined("Guest", "test-room", now, 1));
            assertTrue(requestStarted.await(5, TimeUnit.SECONDS));
            // The first HTTP response is still blocked while the leave action returns.
            assertTimeoutPreemptively(Duration.ofSeconds(1), () -> alerts.left("Guest", "test-room", now, now, 0));
            assertEquals(2, bothDelivered.getCount());
            allowResponse.countDown();
            assertTrue(bothDelivered.await(5, TimeUnit.SECONDS));
        } finally {
            allowResponse.countDown();
            alerts.close();
            server.stop(0);
        }
    }

    @Test
    void disabledAlertsAreSafeAndPartialConfigurationIsRejected() {
        var alerts = new TelegramAlertService("", "", "Asia/Phnom_Penh");
        try {
            assertDoesNotThrow(() -> alerts.joined("Guest", "test-room", Instant.now(), 1));
        } finally { alerts.close(); }
        assertThrows(IllegalArgumentException.class, () -> new TelegramAlertService("", "-123", "UTC"));
        assertThrows(IllegalArgumentException.class, () -> new TelegramAlertService("123:fake", "", "UTC"));
    }
}
