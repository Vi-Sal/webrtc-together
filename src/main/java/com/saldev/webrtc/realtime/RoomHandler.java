package com.saldev.webrtc.realtime;

import java.io.IOException;
import java.time.Instant;
import com.saldev.webrtc.model.DeviceInfo;
import com.saldev.webrtc.service.TelegramAlertService;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Small, in-memory signaling server. Media travels directly between browsers. */
@Component
public class RoomHandler extends TextWebSocketHandler {
    private final JsonMapper json = JsonMapper.builder().build();
    private final Map<String, Member> members = new HashMap<>();
    private final TelegramAlertService alerts;

    public RoomHandler(TelegramAlertService alerts) {
        this.alerts = alerts;
    }

    private record Member(WebSocketSession session, String room, String name, Instant joinedAt, DeviceInfo device) {
        Map<String, String> publicInfo() {
            return Map.of("id", session.getId(), "name", name);
        }
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        session.setTextMessageSizeLimit(65536);
    }

    @Override
    protected synchronized void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException {
        JsonNode body;
        try {
            body = json.readTree(message.getPayload());
        } catch (RuntimeException exception) {
            send(session, Map.of("type", "error", "message", "Invalid message."));
            return;
        }
        if (body == null || !body.isObject()) {
            send(session, Map.of("type", "error", "message", "Invalid message."));
            return;
        }
        String type = body.path("type").asText("");
        if (type.equals("join")) {
            if (members.containsKey(session.getId())) {
                send(session, Map.of("type", "error", "message", "Already joined."));
                return;
            }
            String room = body.path("room").asText("");
            String name = body.path("name").asText("").strip();
            if (!room.matches("[a-zA-Z0-9_-]{8,80}") || name.isEmpty() || name.length() > 40) {
                send(session, Map.of("type", "error", "message", "Enter a name (1–40 characters) and a valid invitation."));
                return;
            }
            List<Member> others = members.values().stream().filter(m -> m.room().equals(room)).toList();
            if (others.size() >= 6) {
                send(session, Map.of("type", "error", "message", "This room is full (6 people maximum)."));
                return;
            }
            Instant joinedAt = Instant.now();
            DeviceInfo device = DeviceInfo.from(body.path("device"));
            members.put(session.getId(), new Member(session, room, name, joinedAt, device));
            alerts.joined(name, room, joinedAt, others.size() + 1, device);
            send(session, Map.of("type", "joined", "id", session.getId(), "peers", others.stream().map(Member::publicInfo).toList()));
            for (Member other : others) {
                send(other.session(), Map.of("type", "peer-joined", "peer", members.get(session.getId()).publicInfo()));
            }
            return;
        }
        Member sender = members.get(session.getId());
        if (sender == null) {
            send(session, Map.of("type", "error", "message", "Join a room first."));
            return;
        }
        if (type.equals("ping")) {
            send(session, Map.of("type", "pong"));
            return;
        }
        if (type.equals("signal")) {
            Member target = members.get(body.path("to").asText(""));
            if (target == null || !target.room().equals(sender.room()) || target == sender) {
                send(session, Map.of("type", "error", "message", "Participant is not in your room."));
                return;
            }
            JsonNode data = body.path("data");
            if (!data.isObject()) return;
            send(target.session(), Map.of("type", "signal", "from", session.getId(), "data", data));
        }
    }

    @Override
    public synchronized void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws IOException {
        Member left = members.remove(session.getId());
        if (left == null) return;
        int remaining = (int) members.values().stream().filter(member -> member.room().equals(left.room())).count();
        alerts.left(left.name(), left.room(), Instant.now(), left.joinedAt(), remaining, left.device());
        for (Member member : members.values()) {
            if (member.room().equals(left.room())) {
                send(member.session(), Map.of("type", "peer-left", "id", session.getId()));
            }
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws IOException {
        session.close(CloseStatus.SERVER_ERROR);
    }

    private void send(WebSocketSession session, Object value) throws IOException {
        if (session.isOpen()) {
            try {
                session.sendMessage(new TextMessage(json.writeValueAsString(value)));
            } catch (IOException exception) {
                session.close(CloseStatus.SERVER_ERROR);
            }
        }
    }
}
