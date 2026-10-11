package com.saldev.webrtc.realtime;

import com.saldev.webrtc.model.chat.ChatHistory;
import com.saldev.webrtc.model.whiteboard.Whiteboard;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/** Membership and bounded collaboration state for one room code. Guarded by the room handler. */
final class Room {
    private static final int MAX_RESUME_TOKENS = 64;

    private final String id;
    private final ChatHistory chat;
    private final Whiteboard board;
    private final Map<String, Participant> members = new LinkedHashMap<>();
    private final Map<String, String> resumeTokens = new LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
            return size() > MAX_RESUME_TOKENS;
        }
    };
    private Instant emptySince;
    private Instant activeSince;

    Room(String id, ChatHistory chat, Whiteboard board, Instant now) {
        this.id = id;
        this.chat = chat;
        this.board = board;
        this.emptySince = now;
    }

    String id() {
        return id;
    }

    ChatHistory chat() {
        return chat;
    }

    Whiteboard board() {
        return board;
    }

    Map<String, Participant> members() {
        return members;
    }

    Instant emptySince() {
        return emptySince;
    }

    /** When the current meeting began: the moment the room last went from empty to occupied. */
    Instant activeSince() {
        return activeSince;
    }

    void add(Participant participant) {
        if (members.isEmpty()) activeSince = participant.joinedAt();
        members.put(participant.id(), participant);
        emptySince = null;
    }

    void remove(Participant participant, Instant now) {
        if (members.get(participant.id()) == participant) members.remove(participant.id());
        if (members.isEmpty()) emptySince = now;
    }

    /** The participant ID that a previously issued token resumes, without consuming it. */
    String resumable(String token) {
        return token == null ? null : resumeTokens.get(token);
    }

    void issueResume(String token, String participantId) {
        resumeTokens.values().removeIf(participantId::equals);
        resumeTokens.put(token, participantId);
    }
}
