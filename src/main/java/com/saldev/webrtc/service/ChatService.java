package com.saldev.webrtc.service;

import com.saldev.webrtc.model.chat.ChatHistory;
import com.saldev.webrtc.model.chat.ChatMessage;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/** Validates chat messages and records them in bounded room history. */
@Service
public class ChatService {
    public static final int MAX_LENGTH = 1000;
    public static final int HISTORY_LIMIT = 100;
    private static final Pattern CLIENT_ID = Pattern.compile("[a-zA-Z0-9_-]{6,64}");

    public record Posted(ChatMessage message, boolean duplicate) {
    }

    public ChatHistory newHistory() {
        return new ChatHistory(HISTORY_LIMIT);
    }

    /**
     * Records a message from a verified participant. A retried client ID returns the original
     * message instead of creating a second copy.
     */
    public Posted post(ChatHistory history, String participantId, String name, String clientId, String rawText) {
        if (clientId == null || !CLIENT_ID.matcher(clientId).matches()) {
            throw new InvalidMessageException("Message could not be sent.", "chat", null);
        }
        String id = participantId + "-" + clientId;
        var existing = history.find(id);
        if (existing.isPresent()) return new Posted(existing.get(), true);
        String text = TextRules.messageText(rawText, MAX_LENGTH * 4);
        if (text.isEmpty()) throw new InvalidMessageException("Message is empty.", "chat", clientId);
        if (TextRules.length(text) > MAX_LENGTH) {
            throw new InvalidMessageException("Messages can be up to " + MAX_LENGTH + " characters.", "chat", clientId);
        }
        ChatMessage message = new ChatMessage(id, participantId, name, text, System.currentTimeMillis());
        history.add(message);
        return new Posted(message, false);
    }
}
