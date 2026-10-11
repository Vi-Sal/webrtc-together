package com.saldev.webrtc.realtime;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * Active and recently emptied rooms. An empty room keeps its chat and board briefly so a refresh
 * or reconnect does not lose them, then expires. Guarded by the room handler.
 */
final class RoomRegistry {
    private final int maxRooms;
    private final Duration emptyRetention;
    private final Map<String, Room> rooms = new HashMap<>();

    RoomRegistry(int maxRooms, Duration emptyRetention) {
        this.maxRooms = maxRooms;
        this.emptyRetention = emptyRetention;
    }

    Room find(String id) {
        return rooms.get(id);
    }

    /** Returns the existing room or a new one; {@code null} when the server is at capacity. */
    Room getOrCreate(String id, Function<String, Room> factory) {
        Room room = rooms.get(id);
        if (room != null) return room;
        if (rooms.size() >= maxRooms) evictOldestEmpty();
        if (rooms.size() >= maxRooms) return null;
        room = factory.apply(id);
        rooms.put(id, room);
        return room;
    }

    int purgeExpired(Instant now) {
        int before = rooms.size();
        rooms.values().removeIf(room -> room.emptySince() != null
                && !room.emptySince().plus(emptyRetention).isAfter(now));
        return before - rooms.size();
    }

    int size() {
        return rooms.size();
    }

    private void evictOldestEmpty() {
        rooms.values().stream()
                .filter(room -> room.emptySince() != null)
                .min(Comparator.comparing(Room::emptySince))
                .ifPresent(room -> rooms.remove(room.id()));
    }
}
