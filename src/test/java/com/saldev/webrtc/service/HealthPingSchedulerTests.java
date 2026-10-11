package com.saldev.webrtc.service;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.boot.web.server.WebServer;

class HealthPingSchedulerTests {
    @Test
    void noRequestBeforeWebServerStarts() {
        var scheduler = new HealthPingScheduler("");
        try { assertDoesNotThrow(scheduler::ping); }
        finally { scheduler.close(); }
    }

    @Test
    void pingRequestsHealthEndpointAndToleratesAnUnhealthyResponse() throws Exception {
        var requests = new AtomicInteger();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/healthz", exchange -> {
            int status = requests.incrementAndGet() == 1 ? 503 : 200;
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
        });
        server.start();
        var scheduler = new HealthPingScheduler("");
        var event = mock(WebServerInitializedEvent.class);
        var webServer = mock(WebServer.class);
        when(event.getWebServer()).thenReturn(webServer);
        when(webServer.getPort()).thenReturn(server.getAddress().getPort());
        scheduler.onWebServerReady(event);
        try {
            assertDoesNotThrow(scheduler::ping);
            assertDoesNotThrow(scheduler::ping);
            assertEquals(2, requests.get());
        } finally {
            scheduler.close();
            server.stop(0);
        }
    }
    @Test
    void usesAutomaticallyProvidedPublicUrlOnRender() throws Exception {
        var requests = new AtomicInteger();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/healthz", exchange -> {
            requests.incrementAndGet();
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        var scheduler = new HealthPingScheduler("http://localhost:" + server.getAddress().getPort() + "/");
        var event = mock(WebServerInitializedEvent.class);
        var webServer = mock(WebServer.class);
        when(event.getWebServer()).thenReturn(webServer);
        when(webServer.getPort()).thenReturn(1); // The public URL must take precedence.
        scheduler.onWebServerReady(event);
        try {
            scheduler.ping();
            assertEquals(1, requests.get());
        } finally {
            scheduler.close();
            server.stop(0);
        }
    }
}
