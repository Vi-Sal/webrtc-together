package com.saldev.webrtc.controller;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CallConfigControllerTests {
    @Test
    void emptyConfigurationSupportsLocalTestingWithoutCachingCredentials() {
        var response = new CallConfigController("", "", "", "").config();
        assertEquals("no-store", response.getHeaders().getCacheControl());
        assertEquals(List.of(), response.getBody().get("iceServers"));
    }

    @Test
    void publishesConfiguredClientCredentials() {
        var response = new CallConfigController(" stun:example.test:3478 ",
                "turns:example.test:443?transport=tcp", "demo", "password").config();
        assertEquals(List.of(Map.of("urls", "stun:example.test:3478"),
                Map.of("urls", "turns:example.test:443?transport=tcp", "username", "demo", "credential", "password")),
                response.getBody().get("iceServers"));
    }

    @Test
    void rejectsEveryPartialTurnConfiguration() {
        for (int mask = 1; mask < 7; mask++) {
            String url = (mask & 1) != 0 ? "turn:example.test:3478" : "";
            String username = (mask & 2) != 0 ? "demo" : "";
            String password = (mask & 4) != 0 ? "password" : "";
            assertThrows(IllegalArgumentException.class,
                    () -> new CallConfigController("", url, username, password));
        }
    }
}
