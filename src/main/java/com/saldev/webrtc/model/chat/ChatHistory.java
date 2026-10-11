package com.saldev.webrtc.model.chat;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Bounded, in-memory recent history for one room. Not thread-safe; guarded by the room handler. */
public final class ChatHistory {
    private final int limit;
    private final ArrayDeque<ChatMessage> messages = new ArrayDeque<>();
    // Remembers more IDs than messages so late client retries are still recognized as duplicates.
    private final Map<String, ChatMessage> recentIds;

    public ChatHistory(int limit) {
        this.limit = limit;
        int idLimit = limit * 4;
        this.recentIds = new LinkedHashMap<>() {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, ChatMessage> eldest) {
                return size() > idLimit;
            }
        };
    }

    public Optional<ChatMessage> find(String id) {
        return Optional.ofNullable(recentIds.get(id));
    }

    public void add(ChatMessage message) {
        messages.addLast(message);
        recentIds.put(message.id(), message);
        while (messages.size() > limit) messages.removeFirst();
    }

    public List<ChatMessage> messages() {
        return List.copyOf(messages);
    }

    public int size() {
        return messages.size();
    }
}
