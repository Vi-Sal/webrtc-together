package com.saldev.webrtc.realtime;

import com.saldev.webrtc.service.ChatService;
import com.saldev.webrtc.service.TelegramAlertService;
import com.saldev.webrtc.service.WhiteboardService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** Chat, whiteboard and reconnect behavior through the real WebSocket handler. */
class RoomCollaborationTests {
    private final RoomHandler handler = new RoomHandler(mock(TelegramAlertService.class), new ChatService(), new WhiteboardService());
    private final JsonMapper json = JsonMapper.builder().build();

    private record Client(WebSocketSession session, List<JsonNode> messages) {
        List<JsonNode> ofType(String type) {
            return messages.stream().filter(m -> m.path("type").asString().equals(type)).toList();
        }

        JsonNode last(String type) {
            List<JsonNode> matching = ofType(type);
            assertFalse(matching.isEmpty(), "expected a " + type + " message");
            return matching.getLast();
        }

        String id() {
            return last("joined").path("id").asString();
        }
    }

    private int sessions;

    private Client client() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn("session-" + sessions++);
        when(session.isOpen()).thenReturn(true);
        List<JsonNode> messages = new ArrayList<>();
        doAnswer(invocation -> {
            messages.add(json.readTree(((TextMessage) invocation.getArgument(0)).getPayload()));
            return null;
        }).when(session).sendMessage(any());
        return new Client(session, messages);
    }

    private void send(Client client, String body) throws Exception {
        handler.handleTextMessage(client.session(), new TextMessage(body));
    }

    private Client joined(String room, String name) throws Exception {
        Client client = client();
        send(client, "{\"type\":\"join\",\"room\":\"" + room + "\",\"name\":\"" + name + "\"}");
        assertEquals("joined", client.messages().getLast().path("type").asString());
        return client;
    }

    private static String stroke(String id) {
        return "{\"type\":\"board-add\",\"element\":{\"id\":\"" + id + "\",\"kind\":\"pen\",\"color\":\"#243341\",\"size\":4,\"points\":[0.1,0.2,0.3,0.4]}}";
    }

    @Test
    void chatIsBroadcastWithinTheRoomWithServerIdentity() throws Exception {
        Client alice = joined("chat-room-1", "Alice"), bob = joined("chat-room-1", "Bob"), outsider = joined("chat-room-2", "Eve");
        send(alice, "{\"type\":\"chat\",\"id\":\"msg-0001\",\"text\":\"  Hello <b>Bob</b>  \",\"from\":\"forged\",\"name\":\"Mallory\"}");
        JsonNode received = bob.last("chat").path("message");
        assertEquals("Hello <b>Bob</b>", received.path("text").asString(), "text is stored verbatim and rendered as text by clients");
        assertEquals(alice.id(), received.path("from").asString());
        assertEquals("Alice", received.path("name").asString());
        assertTrue(received.path("ts").asLong() > 0);
        assertEquals(received, alice.last("chat").path("message"), "sender receives the authoritative copy");
        assertTrue(outsider.ofType("chat").isEmpty(), "messages never leak to other rooms");
    }

    @Test
    void retriedChatMessagesAreNotDuplicated() throws Exception {
        Client alice = joined("chat-retry-room", "Alice"), bob = joined("chat-retry-room", "Bob");
        send(alice, "{\"type\":\"chat\",\"id\":\"retry-01\",\"text\":\"Once\"}");
        send(alice, "{\"type\":\"chat\",\"id\":\"retry-01\",\"text\":\"Once\"}");
        assertEquals(1, bob.ofType("chat").size());
        assertEquals(2, alice.ofType("chat").size(), "the retry is acknowledged to the sender");
        Client late = joined("chat-retry-room", "Late");
        assertEquals(1, late.last("joined").path("chat").size());
    }

    @Test
    void invalidChatIsRejectedWithItsReference() throws Exception {
        Client alice = joined("chat-invalid-room", "Alice"), bob = joined("chat-invalid-room", "Bob");
        send(alice, "{\"type\":\"chat\",\"id\":\"empty-01\",\"text\":\"  \\n \"}");
        assertEquals("empty-01", alice.last("error").path("ref").asString());
        assertEquals("chat", alice.last("error").path("code").asString());
        send(alice, "{\"type\":\"chat\",\"id\":\"long-001\",\"text\":\"" + "x".repeat(ChatService.MAX_LENGTH + 1) + "\"}");
        assertEquals("long-001", alice.last("error").path("ref").asString());
        send(alice, "{\"type\":\"chat\",\"id\":\"<bad>\",\"text\":\"hi\"}");
        send(alice, "{\"type\":\"chat\",\"id\":\"num-0001\",\"text\":42}");
        assertTrue(bob.ofType("chat").isEmpty());
    }

    @Test
    void chatIsRateLimitedPerParticipant() throws Exception {
        Client alice = joined("chat-rate-room", "Alice"), bob = joined("chat-rate-room", "Bob");
        for (int i = 0; i < 12; i++) send(alice, "{\"type\":\"chat\",\"id\":\"burst-" + (100 + i) + "\",\"text\":\"spam\"}");
        int delivered = bob.ofType("chat").size();
        assertTrue(delivered >= 8 && delivered < 12, "burst capped, delivered " + delivered);
        assertTrue(alice.last("error").path("message").asString().contains("too quickly"));
        send(bob, "{\"type\":\"chat\",\"id\":\"bob-0001\",\"text\":\"still here\"}");
        assertEquals("still here", alice.last("chat").path("message").path("text").asString(), "limits are per participant");
    }

    @Test
    void typingIsRelayedToOthersOnly() throws Exception {
        Client alice = joined("typing-room", "Alice"), bob = joined("typing-room", "Bob");
        send(alice, "{\"type\":\"typing\"}");
        assertEquals("Alice", bob.last("chat-typing").path("name").asString());
        assertTrue(alice.ofType("chat-typing").isEmpty());
    }

    @Test
    void boardOperationsAreOrderedAndIsolated() throws Exception {
        Client alice = joined("board-room-1", "Alice"), bob = joined("board-room-1", "Bob"), outsider = joined("board-room-2", "Eve");
        send(alice, stroke("stroke-a1"));
        send(bob, "{\"type\":\"board-add\",\"element\":{\"id\":\"rect-b1\",\"kind\":\"rect\",\"color\":\"#8DAFC0\",\"size\":3,\"points\":[0.5,0.5,0.9,0.9]}}");
        List<JsonNode> adds = alice.ofType("board-add");
        assertEquals(2, adds.size());
        assertEquals(1, adds.get(0).path("seq").asLong());
        assertEquals(2, adds.get(1).path("seq").asLong());
        assertEquals(alice.id(), adds.get(0).path("element").path("author").asString());
        assertEquals("#8dafc0", adds.get(1).path("element").path("color").asString());
        assertEquals(adds, bob.ofType("board-add"), "everyone sees the same order");
        assertTrue(outsider.ofType("board-add").isEmpty());
    }

    @Test
    void duplicateBoardOperationsAreAcknowledgedOnce() throws Exception {
        Client alice = joined("board-dup-room", "Alice"), bob = joined("board-dup-room", "Bob");
        send(alice, stroke("stroke-dup"));
        send(alice, stroke("stroke-dup"));
        assertEquals(1, bob.ofType("board-add").size());
        assertEquals("stroke-dup", alice.last("board-ack").path("id").asString());
    }

    @Test
    void lateJoinerReceivesSnapshotThenOnlyNewOperations() throws Exception {
        Client alice = joined("board-late-room", "Alice");
        send(alice, stroke("stroke-0001"));
        send(alice, stroke("stroke-0002"));
        send(alice, "{\"type\":\"board-undo\",\"id\":\"stroke-0002\"}");
        Client late = joined("board-late-room", "Late");
        JsonNode board = late.last("joined").path("board");
        assertEquals(3, board.path("seq").asLong());
        assertEquals(2, board.path("elements").size());
        assertTrue(board.path("elements").get(1).path("hidden").asBoolean());
        send(alice, stroke("stroke-0003"));
        assertEquals(4, late.last("board-add").path("seq").asLong(), "next operation follows the snapshot without gaps");
        send(late, "{\"type\":\"board-sync\"}");
        assertEquals(3, late.last("board-snapshot").path("elements").size());
    }

    @Test
    void undoAndRedoOnlyAffectOwnElements() throws Exception {
        Client alice = joined("board-undo-room", "Alice"), bob = joined("board-undo-room", "Bob");
        send(alice, stroke("alice-line"));
        send(bob, "{\"type\":\"board-undo\",\"id\":\"alice-line\"}");
        assertTrue(alice.ofType("board-undo").isEmpty());
        assertEquals("board", bob.last("error").path("code").asString());
        send(alice, "{\"type\":\"board-undo\",\"id\":\"alice-line\"}");
        assertEquals("alice-line", bob.last("board-undo").path("id").asString());
        send(alice, "{\"type\":\"board-undo\",\"id\":\"alice-line\"}");
        assertEquals(1, bob.ofType("board-undo").size(), "repeated undo is a no-op");
        send(alice, "{\"type\":\"board-redo\",\"id\":\"alice-line\"}");
        assertEquals(3, bob.last("board-redo").path("seq").asLong());
    }

    @Test
    void clearIsBroadcastWithTheActor() throws Exception {
        Client alice = joined("board-clear-room", "Alice"), bob = joined("board-clear-room", "Bob");
        send(alice, stroke("before-clear"));
        send(bob, "{\"type\":\"board-clear\"}");
        JsonNode clear = alice.last("board-clear");
        assertEquals("Bob", clear.path("name").asString());
        assertEquals(2, clear.path("seq").asLong());
        assertEquals(0, joined("board-clear-room", "Late").last("joined").path("board").path("elements").size());
    }

    @Test
    void invalidBoardPayloadsAreRejectedWithoutAffectingOthers() throws Exception {
        Client alice = joined("board-invalid-room", "Alice"), bob = joined("board-invalid-room", "Bob");
        for (String element : List.of(
                "{\"id\":\"bad-kind1\",\"kind\":\"image\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0]}",
                "{\"id\":\"bad-color\",\"kind\":\"pen\",\"color\":\"red;}\",\"size\":2,\"points\":[0,0]}",
                "{\"id\":\"bad-size1\",\"kind\":\"pen\",\"color\":\"#000000\",\"size\":500,\"points\":[0,0]}",
                "{\"id\":\"bad-point\",\"kind\":\"pen\",\"color\":\"#000000\",\"size\":2,\"points\":[0,\"x\"]}",
                "{\"id\":\"bad-odd01\",\"kind\":\"pen\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0,1]}",
                "{\"id\":\"bad-rect1\",\"kind\":\"rect\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0]}",
                "{\"id\":\"bad-text1\",\"kind\":\"text\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0],\"text\":\" \"}",
                "[]")) {
            send(alice, "{\"type\":\"board-add\",\"element\":" + element + "}");
            assertEquals("error", alice.messages().getLast().path("type").asString(), element);
        }
        assertTrue(bob.ofType("board-add").isEmpty());
        send(alice, stroke("valid-after"));
        assertEquals(1, bob.ofType("board-add").size(), "session remains usable");
    }

    @Test
    void coordinatesAreClampedToTheBoard() throws Exception {
        Client alice = joined("board-clamp-room", "Alice");
        send(alice, "{\"type\":\"board-add\",\"element\":{\"id\":\"clamped1\",\"kind\":\"line\",\"color\":\"#000000\",\"size\":2,\"points\":[-4,0.5,7,1.2]}}");
        JsonNode points = alice.last("board-add").path("element").path("points");
        assertEquals(List.of(0.0, 0.5, 1.0, 1.0), List.of(points.get(0).asDouble(), points.get(1).asDouble(), points.get(2).asDouble(), points.get(3).asDouble()));
    }

    @Test
    void liveStrokesAndCursorsAreRelayedButNotStored() throws Exception {
        Client alice = joined("board-live-room", "Alice"), bob = joined("board-live-room", "Bob");
        send(alice, "{\"type\":\"board-live\",\"id\":\"live-001\",\"kind\":\"pen\",\"color\":\"#243341\",\"size\":4,\"points\":[0.1,0.1,0.2,0.2],\"extra\":\"<script>\"}");
        JsonNode live = bob.last("board-live");
        assertEquals(alice.id(), live.path("from").asString());
        assertFalse(live.has("extra"), "only validated fields are relayed");
        send(alice, "{\"type\":\"board-cursor\",\"points\":[0.25,0.75]}");
        assertEquals(0.75, bob.last("board-cursor").path("points").get(1).asDouble(), 1e-6);
        send(alice, "{\"type\":\"board-cursor\",\"hidden\":true}");
        assertTrue(bob.last("board-cursor").path("hidden").asBoolean());
        assertEquals(0, joined("board-live-room", "Late").last("joined").path("board").path("elements").size());
    }

    @Test
    void resumeTokenKeepsIdentityAndReplacesStaleConnection() throws Exception {
        Client alice = joined("resume-room-1", "Alice"), bob = joined("resume-room-1", "Bob");
        String aliceId = alice.id();
        String token = alice.last("joined").path("resume").asString();
        send(alice, stroke("before-drop"));
        Client again = client();
        send(again, "{\"type\":\"join\",\"room\":\"resume-room-1\",\"name\":\"Alice\",\"resume\":\"" + token + "\"}");
        assertEquals(aliceId, again.id());
        assertEquals(aliceId, bob.last("peer-left").path("id").asString(), "stale socket is removed first");
        assertEquals(aliceId, bob.last("peer-joined").path("peer").path("id").asString());
        verify(alice.session()).close(any(CloseStatus.class));
        send(again, "{\"type\":\"board-undo\",\"id\":\"before-drop\"}");
        assertEquals("before-drop", bob.last("board-undo").path("id").asString(), "undo works across reconnects");
        assertNotEquals(token, again.last("joined").path("resume").asString(), "tokens rotate");
        Client thief = client();
        send(thief, "{\"type\":\"join\",\"room\":\"resume-room-1\",\"name\":\"Eve\",\"resume\":\"" + token + "\"}");
        assertNotEquals(aliceId, thief.id(), "a used token cannot be replayed");
    }

    @Test
    void resumeTokensDoNotCrossRooms() throws Exception {
        Client alice = joined("resume-room-a", "Alice");
        String token = alice.last("joined").path("resume").asString();
        joined("resume-room-b", "Other");
        Client other = client();
        send(other, "{\"type\":\"join\",\"room\":\"resume-room-b\",\"name\":\"Alice\",\"resume\":\"" + token + "\"}");
        assertNotEquals(alice.id(), other.id());
    }

    @Test
    void emptyRoomsKeepStateBrieflyThenExpire() throws Exception {
        Client alice = joined("expiry-room", "Alice");
        send(alice, "{\"type\":\"chat\",\"id\":\"keep-001\",\"text\":\"still here after refresh\"}");
        handler.afterConnectionClosed(alice.session(), CloseStatus.NORMAL);
        assertEquals(1, joined("expiry-room", "Refresh").last("joined").path("chat").size());
        handler.purgeExpiredRooms(Instant.now().plus(RoomHandler.EMPTY_ROOM_RETENTION).plusSeconds(1));
        assertEquals(1, handler.roomCount(), "occupied rooms are never purged");
    }

    @Test
    void expiredRoomsAreRemoved() throws Exception {
        Client alice = joined("expire-now-room", "Alice");
        send(alice, "{\"type\":\"chat\",\"id\":\"gone-001\",\"text\":\"bye\"}");
        handler.afterConnectionClosed(alice.session(), CloseStatus.NORMAL);
        handler.purgeExpiredRooms(Instant.now().plus(RoomHandler.EMPTY_ROOM_RETENTION).plusSeconds(1));
        assertEquals(0, handler.roomCount());
        assertEquals(0, joined("expire-now-room", "Later").last("joined").path("chat").size());
    }

    @Test
    void displayNamesAreSanitized() throws Exception {
        Client alice = client();
        send(alice, "{\"type\":\"join\",\"room\":\"name-room-1\",\"name\":\"  Al\\u202Eice\\n\\tSmith  \"}");
        assertEquals("Al ice Smith", alice.last("joined").path("name").asString());
        Client blank = client();
        send(blank, "{\"type\":\"join\",\"room\":\"name-room-1\",\"name\":\"\\u202E\\n\"}");
        assertEquals("error", blank.messages().getLast().path("type").asString());
    }

    @Test
    void unknownTypesAndExceptionsOnlyAffectTheSender() throws Exception {
        Client alice = joined("unknown-room", "Alice"), bob = joined("unknown-room", "Bob");
        int before = bob.messages().size();
        send(alice, "{\"type\":\"board-add\"}");
        send(alice, "{\"type\":\"made-up\"}");
        send(alice, "{\"type\":\"board-cursor\",\"points\":\"oops\"}");
        assertEquals(before, bob.messages().size());
        assertEquals("Unsupported message type.", alice.ofType("error").get(1).path("message").asString());
    }
}
