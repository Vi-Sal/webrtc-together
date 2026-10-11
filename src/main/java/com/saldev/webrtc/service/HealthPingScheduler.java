package com.saldev.webrtc.service;

import jakarta.annotation.PreDestroy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/** Periodically checks the public Render URL or the local instance while running. */
@Service
public class HealthPingScheduler {
    private static final Logger log = LoggerFactory.getLogger(HealthPingScheduler.class);
    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final String renderExternalUrl;
    private volatile URI healthUrl;

    public HealthPingScheduler(@Value("${RENDER_EXTERNAL_URL:}") String renderExternalUrl) {
        this.renderExternalUrl = renderExternalUrl;
    }

    @EventListener
    public void onWebServerReady(WebServerInitializedEvent event) {
        String base = renderExternalUrl.isBlank()
                ? "http://localhost:" + event.getWebServer().getPort()
                : renderExternalUrl.strip().replaceAll("/+$", "");
        healthUrl = URI.create(base + "/healthz");
        log.info("Scheduled health requests target {}", healthUrl);
    }

    @Scheduled(initialDelayString = "${health-ping.interval-ms:300000}",
            fixedDelayString = "${health-ping.interval-ms:300000}")
    public void ping() {
        URI target = healthUrl;
        if (target == null) {
            log.warn("Scheduled health request skipped: web server is not ready.");
            return;
        }
        try {
            var request = HttpRequest.newBuilder(target)
                    .GET()
                    .timeout(Duration.ofSeconds(10))
                    .build();
            int status = client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
            if (status < 200 || status >= 300) {
                log.warn("Scheduled health request returned HTTP {}", status);
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        } catch (Exception exception) {
            // Failed checks must not affect rooms or startup.
            log.warn("Scheduled health request failed: {}", exception.getClass().getSimpleName());
        }
    }

    @PreDestroy
    public void close() {
        client.shutdownNow();
    }
}
