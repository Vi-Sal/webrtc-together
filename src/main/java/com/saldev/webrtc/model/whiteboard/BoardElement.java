package com.saldev.webrtc.model.whiteboard;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One committed whiteboard operation. Points are normalized {@code x,y} pairs in the 0–1 range of
 * the shared 16:9 board, so every screen size and pixel ratio renders the same drawing.
 * {@code size} is measured in units of 1/1000 of the board width.
 */
public record BoardElement(String id, String author, String kind, String color, double size, float[] points, String text) {
    public Map<String, Object> toJson(boolean hidden) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("id", id);
        json.put("author", author);
        json.put("kind", kind);
        json.put("color", color);
        json.put("size", size);
        json.put("points", points);
        if (text != null) json.put("text", text);
        if (hidden) json.put("hidden", true);
        return json;
    }
}
