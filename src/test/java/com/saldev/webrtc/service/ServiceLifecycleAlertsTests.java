package com.saldev.webrtc.service;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class ServiceLifecycleAlertsTests {
    @Test
    void springReadyAndCloseEventsGenerateExactlyOneAlertEach() {
        TelegramAlertService alerts = mock(TelegramAlertService.class);
        var context = new AnnotationConfigApplicationContext();
        var lifecycle = new ServiceLifecycleAlerts(alerts, "webrtc", "render-instance-1");
        context.registerBean(ServiceLifecycleAlerts.class, () -> lifecycle);
        context.refresh();
        try {
            verifyNoInteractions(alerts);
            var event = new ApplicationReadyEvent(new SpringApplication(), new String[0], context, Duration.ZERO);
            context.publishEvent(event);
            context.publishEvent(event);
        } finally { context.close(); }
        lifecycle.stopping();
        var order = inOrder(alerts);
        order.verify(alerts).serviceUp(eq("webrtc"), eq("render-instance-1"), any());
        order.verify(alerts).serviceStopping(eq("webrtc"), eq("render-instance-1"), any(), any());
        verifyNoMoreInteractions(alerts);
    }

    @Test
    void shutdownBeforeReadyDoesNotAnnounceAnUpOrSleepTransition() {
        TelegramAlertService alerts = mock(TelegramAlertService.class);
        var lifecycle = new ServiceLifecycleAlerts(alerts, "webrtc", "");
        lifecycle.stopping();
        lifecycle.started();
        verifyNoInteractions(alerts);
    }
}
