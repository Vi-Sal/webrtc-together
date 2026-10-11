package com.saldev.webrtc.realtime;

import java.util.ArrayList;
import com.saldev.webrtc.service.ChatService;
import com.saldev.webrtc.service.TelegramAlertService;
import com.saldev.webrtc.service.WhiteboardService;
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

class RoomHandlerTests {
    private final TelegramAlertService alerts = mock(TelegramAlertService.class);
    private final RoomHandler handler = new RoomHandler(alerts, new ChatService(), new WhiteboardService());
    private final JsonMapper json = JsonMapper.builder().build();
    private record Client(WebSocketSession session, List<JsonNode> messages) {}

    private Client client(String id) throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn(id);
        when(session.isOpen()).thenReturn(true);
        List<JsonNode> messages = new ArrayList<>();
        doAnswer(invocation -> {
            messages.add(json.readTree(((TextMessage) invocation.getArgument(0)).getPayload()));
            return null;
        }).when(session).sendMessage(any());
        return new Client(session, messages);
    }

    private void message(Client client, String body) throws Exception {
        handler.handleTextMessage(client.session(), new TextMessage(body));
    }

    private void join(Client client, String room) throws Exception {
        message(client, "{\"type\":\"join\",\"room\":\"" + room + "\",\"name\":\"Guest\"}");
    }

    private String id(Client client) {
        return client.messages().stream().filter(m -> m.path("type").asString().equals("joined"))
                .reduce((first, second) -> second).orElseThrow().path("id").asString();
    }

    @Test
    void routesSignalsOnlyWithinRoomAndUsesServerIdentity() throws Exception {
        Client alice = client("alice"), bob = client("bob"), outsider = client("outsider");
        join(alice, "room-one"); join(bob, "room-one"); join(outsider, "room-two");
        String aliceId = id(alice), bobId = id(bob);
        assertNotEquals("alice", aliceId, "WebSocket session IDs are not exposed as participant IDs");
        assertEquals(aliceId, bob.messages().getFirst().path("peers").get(0).path("id").asString());
        message(alice, "{\"type\":\"signal\",\"to\":\"" + bobId + "\",\"from\":\"forged\",\"data\":{\"candidate\":{}}}");
        assertEquals(aliceId, bob.messages().getLast().path("from").asString());
        int before = outsider.messages().size();
        message(alice, "{\"type\":\"signal\",\"to\":\"" + id(outsider) + "\",\"data\":{}}");
        assertEquals(before, outsider.messages().size());
        assertEquals("error", alice.messages().getLast().path("type").asString());
    }

    @Test
    void enforcesCapacityAndFreesPlaceAfterDisconnect() throws Exception {
        List<Client> clients = new ArrayList<>();
        for (int i = 0; i < 7; i++) { Client client = client("peer-" + i); clients.add(client); join(client, "capacity-room"); }
        assertEquals("error", clients.getLast().messages().getLast().path("type").asString());
        handler.afterConnectionClosed(clients.getFirst().session(), CloseStatus.NORMAL);
        assertEquals("peer-left", clients.get(1).messages().getLast().path("type").asString());
        join(clients.getLast(), "capacity-room");
        assertEquals("joined", clients.getLast().messages().getLast().path("type").asString());
    }

    @Test
    void rejectsMalformedMessagesInvalidRoomsAndDuplicateJoin() throws Exception {
        Client client = client("one");
        message(client, "not json");
        assertEquals("error", client.messages().getLast().path("type").asString());
        join(client, "bad");
        assertEquals("error", client.messages().getLast().path("type").asString());
        join(client, "valid-room"); join(client, "valid-room");
        assertEquals("Already joined.", client.messages().getLast().path("message").asString());
    }

    @Test
    void cannotSignalBeforeJoining() throws Exception {
        Client client = client("unknown");
        message(client, "{\"type\":\"signal\",\"to\":\"other\",\"data\":{}}");
        assertEquals("Join a room first.", client.messages().getLast().path("message").asString());
    }
    @Test
    void rejectsNonObjectMessagesAndKeepsSessionUsable() throws Exception {
        Client client = client("one");
        for (String payload : List.of("null", "[]", "42", "")) {
            message(client, payload);
            assertEquals("error", client.messages().getLast().path("type").asString());
        }
        join(client, "valid-room");
        assertEquals("joined", client.messages().getLast().path("type").asString());
    }

    @Test
    void heartbeatRepliesOnlyToJoinedSender() throws Exception {
        Client alice = client("alice"), bob = client("bob");
        message(alice, "{\"type\":\"ping\"}");
        assertEquals("error", alice.messages().getLast().path("type").asString());
        join(alice, "valid-room"); join(bob, "valid-room");
        int before = bob.messages().size();
        message(alice, "{\"type\":\"ping\"}");
        assertEquals("pong", alice.messages().getLast().path("type").asString());
        assertEquals(before, bob.messages().size());
    }
    @Test
    void alertsOnlyForActualMembershipChanges() throws Exception {
        Client alice = client("alice"), bob = client("bob"), rejected = client("rejected");
        join(rejected, "bad");
        handler.afterConnectionClosed(rejected.session(), CloseStatus.NORMAL);
        verifyNoInteractions(alerts);
        join(alice, "valid-room");
        join(alice, "valid-room");
        join(bob, "valid-room");
        handler.afterConnectionClosed(alice.session(), CloseStatus.NORMAL);
        handler.afterConnectionClosed(alice.session(), CloseStatus.NORMAL);
        var order = inOrder(alerts);
        order.verify(alerts).joined(eq("Guest"), eq("valid-room"), any(), eq(1), any());
        order.verify(alerts).joined(eq("Guest"), eq("valid-room"), any(), eq(2), any());
        order.verify(alerts).left(eq("Guest"), eq("valid-room"), any(), any(), eq(1), any());
        verifyNoMoreInteractions(alerts);
    }
    @Test
    void keepsDeviceForLeaveAndDoesNotBroadcastItToOtherParticipants() throws Exception {
        Client alice = client("alice"), bob = client("bob");
        message(alice, """
                {"type":"join","room":"test-room","name":"Alice",
                 "device":{"type":"Phone","os":"Android","browser":"Chrome","model":"SM-S938B"}}
                """);
        join(bob, "test-room");
        assertFalse(bob.messages().getFirst().path("peers").get(0).has("device"));
        handler.afterConnectionClosed(alice.session(), CloseStatus.NORMAL);
        var expected = new com.saldev.webrtc.model.DeviceInfo("Phone", "Android", "Chrome", "SM-S938B");
        verify(alerts).joined(eq("Alice"), eq("test-room"), any(), eq(1), eq(expected));
        verify(alerts).left(eq("Alice"), eq("test-room"), any(), any(), eq(1), eq(expected));
    }

    @Test
    void malformedDeviceMetadataDoesNotBlockJoining() throws Exception {
        Client client = client("one");
        message(client, """
                {"type":"join","room":"test-room","name":"Guest","device":{"model":42,"os":[]}}
                """);
        assertEquals("joined", client.messages().getFirst().path("type").asString());
        verify(alerts).joined(eq("Guest"), eq("test-room"), any(), eq(1),
                eq(com.saldev.webrtc.model.DeviceInfo.unknown()));
    }
}
