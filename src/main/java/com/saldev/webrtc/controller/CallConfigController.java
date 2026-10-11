package com.saldev.webrtc.controller;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CallConfigController {
    private final List<Map<String, String>> iceServers;

    public CallConfigController(
            @Value("${call.stun-url:}") String stunUrl,
            @Value("${call.turn-url:}") String turnUrl,
            @Value("${call.turn-username:}") String turnUsername,
            @Value("${call.turn-password:}") String turnPassword) {
        List<Map<String, String>> servers = new ArrayList<>();
        if (!stunUrl.isBlank()) servers.add(Map.of("urls", stunUrl.strip()));
        boolean hasTurn = !turnUrl.isBlank();
        if (hasTurn != (!turnUsername.isBlank() && !turnPassword.isBlank())
                || (!hasTurn && (!turnUsername.isBlank() || !turnPassword.isBlank()))) {
            throw new IllegalArgumentException("Set CALL_TURN_URL, CALL_TURN_USERNAME and CALL_TURN_PASSWORD together.");
        }
        if (hasTurn) servers.add(Map.of("urls", turnUrl.strip(), "username", turnUsername, "credential", turnPassword));
        iceServers = List.copyOf(servers);
    }

    @GetMapping("/api/call-config")
    public ResponseEntity<Map<String, Object>> config() {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(Map.of("iceServers", iceServers, "maxParticipants", 6));
    }
}
