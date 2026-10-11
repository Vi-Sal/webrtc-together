package com.saldev.webrtc.service;

import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class ServiceLifecycleAlerts {
    private final TelegramAlertService alerts;
    private final String service;
    private final String instance;
    private Instant readyAt;
    private boolean stopping;

    public ServiceLifecycleAlerts(TelegramAlertService alerts,
            @Value("${spring.application.name:webrtc}") String service,
            @Value("${RENDER_INSTANCE_ID:}") String renderInstance) {
        this.alerts = alerts;
        this.service = service;
        this.instance = renderInstance.isBlank() ? UUID.randomUUID().toString() : renderInstance;
    }

    @EventListener(ApplicationReadyEvent.class)
    public synchronized void started() {
        if (readyAt != null || stopping) return;
        readyAt = Instant.now();
        alerts.serviceUp(service, instance, readyAt);
    }

    @EventListener(ContextClosedEvent.class)
    public synchronized void stopping() {
        if (stopping) return;
        stopping = true;
        // Failed startup is not a transition from a running service.
        if (readyAt != null) alerts.serviceStopping(service, instance, Instant.now(), readyAt);
    }
}
