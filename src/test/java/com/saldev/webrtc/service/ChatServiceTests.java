package com.saldev.webrtc.service;

import com.saldev.webrtc.model.chat.ChatHistory;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ChatServiceTests {
    private final ChatService service = new ChatService();

    @Test
    void historyKeepsOnlyTheMostRecentMessages() {
        ChatHistory history = service.newHistory();
        for (int i = 0; i < ChatService.HISTORY_LIMIT + 5; i++) {
            service.post(history, "alice", "Alice", "msg-" + (1000 + i), "message " + i);
        }
        assertEquals(ChatService.HISTORY_LIMIT, history.size());
        assertEquals("message 5", history.messages().getFirst().text());
        assertTrue(service.post(history, "alice", "Alice", "msg-1000", "message 0").duplicate(),
                "recently evicted IDs are still recognized as retries");
    }

    @Test
    void messageIdsAreScopedToTheSender() {
        ChatHistory history = service.newHistory();
        var alice = service.post(history, "alice", "Alice", "same-id", "hi");
        var bob = service.post(history, "bob", "Bob", "same-id", "hello");
        assertFalse(bob.duplicate(), "one participant cannot suppress another's message");
        assertNotEquals(alice.message().id(), bob.message().id());
    }

    @Test
    void normalizesTextAndEnforcesLength() {
        ChatHistory history = service.newHistory();
        var posted = service.post(history, "a", "A", "norm-01", "‮line one\r\n\r\n\r\n\r\nline\ttwo\u0007 👨‍👩‍👧");
        assertEquals("line one\n\nline two 👨‍👩‍👧", posted.message().text());
        String limit = "é".repeat(ChatService.MAX_LENGTH);
        assertEquals(limit, service.post(history, "a", "A", "limit-01", limit).message().text());
        var tooLong = assertThrows(InvalidMessageException.class,
                () -> service.post(history, "a", "A", "limit-02", limit + "!"));
        assertEquals("limit-02", tooLong.ref());
        assertThrows(InvalidMessageException.class, () -> service.post(history, "a", "A", "blank-01", " \n\t "));
        assertThrows(InvalidMessageException.class, () -> service.post(history, "a", "A", "bad id", "x"));
        assertThrows(InvalidMessageException.class, () -> service.post(history, "a", "A", null, "x"));
    }

    @Test
    void displayNamesAreSingleLine() {
        assertEquals("Ada Lovelace", TextRules.displayName(" Ada\n Lovelace‮ "));
        assertEquals("", TextRules.displayName("\u0000‮"));
        assertEquals("", TextRules.displayName(null));
    }
}
