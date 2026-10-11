package com.saldev.webrtc.model.chat;

/**
 * A room chat message. {@code from} and {@code name} come from the server-side membership,
 * never from the client payload; {@code ts} is the server receive time in epoch milliseconds.
 */
public record ChatMessage(String id, String from, String name, String text, long ts) {
}
