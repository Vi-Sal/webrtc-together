package com.saldev.webrtc.realtime;

import com.saldev.webrtc.model.DeviceInfo;
import com.saldev.webrtc.model.whiteboard.BoardElement;
import com.saldev.webrtc.model.whiteboard.Whiteboard;
import com.saldev.webrtc.service.ChatService;
import com.saldev.webrtc.service.InvalidMessageException;
import com.saldev.webrtc.service.TelegramAlertService;
import com.saldev.webrtc.service.TextRules;
import com.saldev.webrtc.service.WhiteboardService;
import java.io.IOException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * In-memory room server: membership, WebRTC signaling, chat and whiteboard events share one
 * WebSocket per participant. Media travels directly between browsers.
 *
 * <p>All state changes are serialized on this handler, so each room sees a single, consistent
 * event order and a joining participant's snapshot can never miss or repeat an operation.
 * Outbound messages go through bounded per-session buffers; a slow client is disconnected
 * rather than blocking the room.
 */
@Component
public class RoomHandler extends TextWebSocketHandler {
    static final int PROTOCOL_VERSION = 2;
    static final int MAX_PARTICIPANTS = 6;
    static final int MAX_ROOMS = 300;
    static final Duration EMPTY_ROOM_RETENTION = Duration.ofMinutes(15);
    private static final int MAX_INBOUND_BYTES = 65536;
    private static final int SEND_TIME_LIMIT_MS = 10_000;
    private static final int SEND_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
    private static final Pattern ROOM = Pattern.compile("[a-zA-Z0-9_-]{8,80}");
    private static final Pattern TOKEN = Pattern.compile("[a-zA-Z0-9_-]{20,64}");
    private static final Logger log = LoggerFactory.getLogger(RoomHandler.class);

    private final JsonMapper json = JsonMapper.builder().build();
    private final SecureRandom random = new SecureRandom();
    private final TelegramAlertService alerts;
    private final ChatService chat;
    private final WhiteboardService whiteboard;
    private final RoomRegistry rooms = new RoomRegistry(MAX_ROOMS, EMPTY_ROOM_RETENTION);
    private final Map<String, WebSocketSession> outbound = new HashMap<>();
    private final Map<String, Participant> members = new HashMap<>();

    public RoomHandler(TelegramAlertService alerts, ChatService chat, WhiteboardService whiteboard) {
        this.alerts = alerts;
        this.chat = chat;
        this.whiteboard = whiteboard;
    }

    @Override
    public synchronized void afterConnectionEstablished(WebSocketSession session) {
        session.setTextMessageSizeLimit(MAX_INBOUND_BYTES);
        outbound(session);
    }

    @Override
    protected synchronized void handleTextMessage(WebSocketSession raw, TextMessage message) throws IOException {
        WebSocketSession session = outbound(raw);
        JsonNode body;
        try {
            body = json.readTree(message.getPayload());
        } catch (RuntimeException exception) {
            send(session, error("Invalid message.", null, null));
            return;
        }
        if (body == null || !body.isObject()) {
            send(session, error("Invalid message.", null, null));
            return;
        }
        String type = text(body, "type");
        try {
            if (type.equals("join")) {
                join(session, body);
                return;
            }
            Participant sender = members.get(session.getId());
            if (sender == null) {
                send(session, error("Join a room first.", null, null));
                return;
            }
            dispatch(sender, type, body);
        } catch (InvalidMessageException exception) {
            send(session, error(exception.getMessage(), exception.code(), exception.ref()));
        } catch (RuntimeException exception) {
            // A bad payload must only affect its sender, never the room.
            log.warn("Could not process {} message", type, exception);
            send(session, error("Could not process that message.", null, null));
        }
    }

    private void dispatch(Participant sender, String type, JsonNode body) {
        switch (type) {
            case "ping" -> send(sender.session(), Map.of("type", "pong"));
            case "signal" -> signal(sender, body);
            case "chat" -> chat(sender, body);
            case "typing" -> {
                if (sender.limiter().tryAcquire(RateLimiter.Kind.TYPING)) {
                    broadcast(sender.room(), Map.of("type", "chat-typing", "from", sender.id(), "name", sender.name()), sender);
                }
            }
            case "board-live" -> {
                if (!sender.limiter().tryAcquire(RateLimiter.Kind.LIVE)) return;
                Map<String, Object> live = whiteboard.live(body);
                live.put("type", "board-live");
                live.put("from", sender.id());
                broadcast(sender.room(), live, sender);
            }
            case "board-cursor" -> {
                if (!sender.limiter().tryAcquire(RateLimiter.Kind.LIVE)) return;
                float[] point = whiteboard.cursor(body);
                broadcast(sender.room(), point == null
                        ? Map.of("type", "board-cursor", "from", sender.id(), "hidden", true)
                        : Map.of("type", "board-cursor", "from", sender.id(), "points", point), sender);
            }
            case "board-add" -> boardAdd(sender, body);
            case "board-undo", "board-redo" -> boardHide(sender, body, type.equals("board-undo"));
            case "board-clear" -> {
                limit(sender, RateLimiter.Kind.BOARD, "board");
                Whiteboard board = sender.room().board();
                board.clear();
                broadcast(sender.room(), Map.of("type", "board-clear", "seq", board.seq(), "by", sender.id(), "name", sender.name()), null);
            }
            case "board-sync" -> {
                limit(sender, RateLimiter.Kind.SYNC, "board");
                Map<String, Object> snapshot = new LinkedHashMap<>(boardSnapshot(sender.room()));
                snapshot.put("type", "board-snapshot");
                send(sender.session(), snapshot);
            }
            default -> throw new InvalidMessageException("Unsupported message type.");
        }
    }

    private void join(WebSocketSession session, JsonNode body) {
        if (members.containsKey(session.getId())) throw new InvalidMessageException("Already joined.", "join", null);
        String roomId = text(body, "room");
        String name = TextRules.displayName(text(body, "name"));
        if (!ROOM.matcher(roomId).matches() || name.isEmpty() || TextRules.length(name) > TextRules.MAX_NAME_LENGTH) {
            throw new InvalidMessageException("Enter a name (1–40 characters) and a valid invitation.", "join", null);
        }
        Room existing = rooms.find(roomId);
        String token = text(body, "resume");
        String resumedId = existing != null && TOKEN.matcher(token).matches() ? existing.resumable(token) : null;
        Participant replaced = resumedId == null ? null : existing.members().get(resumedId);
        int others = existing == null ? 0 : existing.members().size() - (replaced == null ? 0 : 1);
        if (others >= MAX_PARTICIPANTS) {
            throw new InvalidMessageException("This room is full (6 people maximum).", "join", null);
        }
        Instant now = Instant.now();
        Room room = rooms.getOrCreate(roomId, id -> new Room(id, chat.newHistory(), whiteboard.newBoard(), now));
        if (room == null) throw new InvalidMessageException("The server is busy. Try again in a few minutes.", "join", null);
        if (replaced != null) evict(replaced, now);

        DeviceInfo device = DeviceInfo.from(body.path("device"));
        String id = resumedId != null ? resumedId : randomId(12);
        Participant participant = new Participant(id, session, room, name, now, device, new RateLimiter(System::nanoTime));
        List<Map<String, String>> peers = room.members().values().stream().map(Participant::publicInfo).toList();
        room.add(participant);
        members.put(session.getId(), participant);
        String resume = randomId(24);
        room.issueResume(resume, id);
        alerts.joined(name, roomId, now, room.members().size(), device);

        Map<String, Object> joined = new LinkedHashMap<>();
        joined.put("type", "joined");
        joined.put("protocol", PROTOCOL_VERSION);
        joined.put("id", id);
        joined.put("name", name);
        joined.put("resume", resume);
        joined.put("peers", peers);
        joined.put("chat", room.chat().messages());
        joined.put("board", boardSnapshot(room));
        joined.put("startedAt", room.activeSince().toEpochMilli());
        joined.put("now", now.toEpochMilli());
        joined.put("limits", Map.of("participants", MAX_PARTICIPANTS, "chatLength", ChatService.MAX_LENGTH));
        send(session, joined);
        broadcast(room, Map.of("type", "peer-joined", "peer", participant.publicInfo()), participant);
    }

    private void signal(Participant sender, JsonNode body) {
        limit(sender, RateLimiter.Kind.SIGNAL, null);
        Participant target = sender.room().members().get(text(body, "to"));
        if (target == null || target == sender) {
            throw new InvalidMessageException("Participant is not in your room.");
        }
        JsonNode data = body.path("data");
        if (!data.isObject()) return;
        send(target.session(), Map.of("type", "signal", "from", sender.id(), "data", data));
    }

    private void chat(Participant sender, JsonNode body) {
        String clientId = text(body, "id");
        if (!sender.limiter().tryAcquire(RateLimiter.Kind.CHAT)) {
            throw new InvalidMessageException("You're sending messages too quickly. Wait a moment.", "chat", clientId);
        }
        ChatService.Posted posted = chat.post(sender.room().chat(), sender.id(), sender.name(), clientId, text(body, "text"));
        Map<String, Object> event = Map.of("type", "chat", "message", posted.message());
        // A retried message is only acknowledged to its sender; others already have it.
        if (posted.duplicate()) send(sender.session(), event);
        else broadcast(sender.room(), event, null);
    }

    private void boardAdd(Participant sender, JsonNode body) {
        limit(sender, RateLimiter.Kind.BOARD, "board");
        BoardElement element = whiteboard.parse(body.path("element"), sender.id());
        Whiteboard board = sender.room().board();
        if (whiteboard.add(board, element) == Whiteboard.AddResult.DUPLICATE) {
            send(sender.session(), Map.of("type", "board-ack", "id", element.id()));
            return;
        }
        broadcast(sender.room(), Map.of("type", "board-add", "seq", board.seq(), "element", element.toJson(false)), null);
    }

    private void boardHide(Participant sender, JsonNode body, boolean hide) {
        limit(sender, RateLimiter.Kind.BOARD, "board");
        String id = whiteboard.elementId(body);
        Whiteboard board = sender.room().board();
        if (whiteboard.setHidden(board, sender.id(), id, hide)) {
            broadcast(sender.room(), Map.of("type", hide ? "board-undo" : "board-redo", "id", id, "seq", board.seq()), null);
        }
    }

    private Map<String, Object> boardSnapshot(Room room) {
        return Map.of("seq", room.board().seq(), "elements", room.board().snapshot());
    }

    @Override
    public synchronized void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        outbound.remove(session.getId());
        Participant left = members.remove(session.getId());
        if (left == null) return;
        Instant now = Instant.now();
        left.room().remove(left, now);
        alerts.left(left.name(), left.room().id(), now, left.joinedAt(), left.room().members().size(), left.device());
        broadcast(left.room(), Map.of("type", "peer-left", "id", left.id()), null);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws IOException {
        session.close(CloseStatus.SERVER_ERROR);
    }

    /** Releases rooms that have been empty longer than the retention period. */
    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000)
    public synchronized void purgeExpiredRooms() {
        int purged = rooms.purgeExpired(Instant.now());
        if (purged > 0) log.debug("Purged {} expired rooms", purged);
    }

    synchronized int roomCount() {
        return rooms.size();
    }

    synchronized void purgeExpiredRooms(Instant now) {
        rooms.purgeExpired(now);
    }

    // A reconnecting client resumed its identity while the server still held its old socket.
    private void evict(Participant stale, Instant now) {
        members.remove(stale.session().getId());
        outbound.remove(stale.session().getId());
        stale.room().remove(stale, now);
        alerts.left(stale.name(), stale.room().id(), now, stale.joinedAt(), stale.room().members().size(), stale.device());
        broadcast(stale.room(), Map.of("type", "peer-left", "id", stale.id()), null);
        try {
            stale.session().close(new CloseStatus(4001, "Joined from a new connection"));
        } catch (IOException | RuntimeException ignored) {
            // The old connection is usually already gone.
        }
    }

    private void limit(Participant sender, RateLimiter.Kind kind, String code) {
        if (!sender.limiter().tryAcquire(kind)) {
            throw new InvalidMessageException("Too many requests. Slow down and try again.", code, null);
        }
    }

    private void broadcast(Room room, Object value, Participant except) {
        String payload = serialize(value);
        for (Participant member : List.copyOf(room.members().values())) {
            if (member != except) sendRaw(member.session(), payload);
        }
    }

    private void send(WebSocketSession session, Object value) {
        sendRaw(session, serialize(value));
    }

    private String serialize(Object value) {
        return json.writeValueAsString(value);
    }

    private void sendRaw(WebSocketSession session, String payload) {
        if (!session.isOpen()) return;
        try {
            session.sendMessage(new TextMessage(payload));
        } catch (IOException | RuntimeException exception) {
            // Includes buffer/time limit overflow for a client that stopped reading.
            try {
                session.close(CloseStatus.SESSION_NOT_RELIABLE);
            } catch (IOException | RuntimeException ignored) {
                // Already closing.
            }
        }
    }

    private WebSocketSession outbound(WebSocketSession session) {
        return outbound.computeIfAbsent(session.getId(), id -> new ConcurrentWebSocketSessionDecorator(
                session, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT_BYTES, ConcurrentWebSocketSessionDecorator.OverflowStrategy.TERMINATE));
    }

    private static Map<String, Object> error(String message, String code, String ref) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("type", "error");
        error.put("message", message);
        if (code != null) error.put("code", code);
        if (ref != null) error.put("ref", ref);
        return error;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isString() ? value.asString() : "";
    }

    private String randomId(int bytes) {
        byte[] value = new byte[bytes];
        random.nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }
}
