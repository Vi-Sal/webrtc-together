package com.saldev.webrtc.service;

import com.saldev.webrtc.model.whiteboard.BoardElement;
import com.saldev.webrtc.model.whiteboard.Whiteboard;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

/** Validates whiteboard payloads and applies the room's collaborative editing rules. */
@Service
public class WhiteboardService {
    public static final int MAX_ELEMENTS = 2000;
    public static final int MAX_BOARD_POINTS = 120_000;
    public static final int MAX_STROKE_POINTS = 4000;
    public static final int MAX_LIVE_POINTS = 800;
    public static final int MAX_TEXT_LENGTH = 200;

    private static final Pattern ID = Pattern.compile("[a-zA-Z0-9_-]{6,64}");
    private static final Pattern COLOR = Pattern.compile("#[0-9a-fA-F]{6}");
    private static final Set<String> FREEHAND = Set.of("pen", "eraser");
    private static final Set<String> SHAPES = Set.of("line", "rect", "ellipse");

    public Whiteboard newBoard() {
        return new Whiteboard(MAX_ELEMENTS, MAX_BOARD_POINTS);
    }

    /** Builds a committed element; {@code author} is the server-verified participant ID. */
    public BoardElement parse(JsonNode node, String author) {
        if (node == null || !node.isObject()) throw invalid(null, "Invalid drawing.");
        String id = id(node);
        String kind = string(node, "kind");
        int min, max;
        if (FREEHAND.contains(kind)) {
            min = 2;
            max = MAX_STROKE_POINTS;
        } else if (SHAPES.contains(kind)) {
            min = max = 4;
        } else if (kind.equals("text")) {
            min = max = 2;
        } else {
            throw invalid(id, "Unsupported drawing tool.");
        }
        float[] points = points(node.path("points"), min, max, id);
        String text = null;
        if (kind.equals("text")) {
            text = TextRules.messageText(string(node, "text"), MAX_TEXT_LENGTH * 4).replaceAll("\\s+", " ");
            if (text.isEmpty() || TextRules.length(text) > MAX_TEXT_LENGTH) {
                throw invalid(id, "Text must be 1–" + MAX_TEXT_LENGTH + " characters.");
            }
        }
        return new BoardElement(id, author, kind, color(node, id), size(node, id), points, text);
    }

    /** Sanitized in-progress preview for other participants. It is relayed but never stored. */
    public Map<String, Object> live(JsonNode node) {
        String id = id(node);
        String kind = string(node, "kind");
        if (!FREEHAND.contains(kind) && !SHAPES.contains(kind)) throw invalid(id, "Unsupported drawing tool.");
        int min = SHAPES.contains(kind) ? 4 : 2;
        int max = SHAPES.contains(kind) ? 4 : MAX_LIVE_POINTS;
        Map<String, Object> live = new LinkedHashMap<>();
        live.put("id", id);
        live.put("kind", kind);
        live.put("color", color(node, id));
        live.put("size", size(node, id));
        live.put("points", points(node.path("points"), min, max, id));
        return live;
    }

    /** A cursor position, or {@code null} when the participant's cursor left the board. */
    public float[] cursor(JsonNode node) {
        if (node.path("hidden").asBoolean(false)) return null;
        return points(node.path("points"), 2, 2, null);
    }

    public String elementId(JsonNode node) {
        return id(node);
    }

    public Whiteboard.AddResult add(Whiteboard board, BoardElement element) {
        Whiteboard.AddResult result = board.add(element);
        if (result == Whiteboard.AddResult.FULL) {
            throw invalid(element.id(), "The whiteboard is full. Clear it to keep drawing.");
        }
        return result;
    }

    /**
     * Undo and redo only change the requester's own elements, so collaborators never lose work
     * to someone else's undo. Returns false when the change was already applied or no longer exists.
     */
    public boolean setHidden(Whiteboard board, String author, String id, boolean hidden) {
        BoardElement element = board.find(id);
        if (element != null && !element.author().equals(author)) {
            throw invalid(id, "You can only undo or redo your own drawings.");
        }
        return board.setHidden(id, author, hidden);
    }

    private static String id(JsonNode node) {
        String id = string(node, "id");
        if (!ID.matcher(id).matches()) throw invalid(null, "Invalid drawing.");
        return id;
    }

    private static String color(JsonNode node, String id) {
        String color = string(node, "color");
        if (!COLOR.matcher(color).matches()) throw invalid(id, "Invalid color.");
        return color.toLowerCase();
    }

    private static double size(JsonNode node, String id) {
        JsonNode size = node.path("size");
        double value = size.isNumber() ? size.asDouble() : Double.NaN;
        if (!(value >= 1 && value <= 96)) throw invalid(id, "Invalid brush size.");
        return Math.round(value * 10) / 10.0;
    }

    private static float[] points(JsonNode node, int min, int max, String id) {
        if (!node.isArray() || node.size() < min || node.size() > max || node.size() % 2 != 0) {
            throw invalid(id, "Invalid drawing coordinates.");
        }
        float[] points = new float[node.size()];
        for (int i = 0; i < points.length; i++) {
            JsonNode value = node.get(i);
            double number = value.isNumber() ? value.asDouble() : Double.NaN;
            if (!Double.isFinite(number)) throw invalid(id, "Invalid drawing coordinates.");
            points[i] = (float) Math.max(0, Math.min(1, number));
        }
        return points;
    }

    private static String string(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isString() ? value.asString() : "";
    }

    private static InvalidMessageException invalid(String id, String message) {
        return new InvalidMessageException(message, "board", id);
    }
}
