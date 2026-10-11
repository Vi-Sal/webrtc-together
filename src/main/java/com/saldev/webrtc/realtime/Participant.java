package com.saldev.webrtc.realtime;

import com.saldev.webrtc.model.DeviceInfo;
import java.time.Instant;
import java.util.Map;
import org.springframework.web.socket.WebSocketSession;

/**
 * A verified room member. {@code id} is server-issued and survives reconnects (via a resume
 * token), unlike the WebSocket session ID, which is never shared with other participants.
 */
record Participant(String id, WebSocketSession session, Room room, String name, Instant joinedAt,
                   DeviceInfo device, RateLimiter limiter) {
    Map<String, String> publicInfo() {
        return Map.of("id", id, "name", name);
    }
}
