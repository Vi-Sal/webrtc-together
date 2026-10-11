package com.saldev.webrtc.service;

import com.saldev.webrtc.model.whiteboard.BoardElement;
import com.saldev.webrtc.model.whiteboard.Whiteboard;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;

class WhiteboardServiceTests {
    private final WhiteboardService service = new WhiteboardService();
    private final JsonMapper json = JsonMapper.builder().build();

    private JsonNode node(String value) {
        return json.readTree(value);
    }

    private BoardElement stroke(String id, String author, int points) {
        StringBuilder values = new StringBuilder();
        for (int i = 0; i < points; i++) values.append(i == 0 ? "" : ",").append("0.5");
        return service.parse(node("{\"id\":\"" + id + "\",\"kind\":\"pen\",\"color\":\"#243341\",\"size\":3,\"points\":[" + values + "]}"), author);
    }

    @Test
    void parsesEveryTool() {
        for (String element : new String[]{
                "{\"id\":\"pen-0001\",\"kind\":\"pen\",\"color\":\"#000000\",\"size\":2,\"points\":[0.1,0.1,0.2,0.2]}",
                "{\"id\":\"erase-001\",\"kind\":\"eraser\",\"color\":\"#000000\",\"size\":20,\"points\":[0.1,0.1]}",
                "{\"id\":\"line-0001\",\"kind\":\"line\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0,1,1]}",
                "{\"id\":\"rect-0001\",\"kind\":\"rect\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0,1,1]}",
                "{\"id\":\"oval-0001\",\"kind\":\"ellipse\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0,1,1]}",
                "{\"id\":\"text-0001\",\"kind\":\"text\",\"color\":\"#000000\",\"size\":24,\"points\":[0.5,0.5],\"text\":\"Hi\\nthere\"}"}) {
            assertEquals("me", service.parse(node(element), "me").author());
        }
        BoardElement text = service.parse(node("{\"id\":\"text-0002\",\"kind\":\"text\",\"color\":\"#000000\",\"size\":24,\"points\":[0.5,0.5],\"text\":\"<img onerror=x>\"}"), "me");
        assertEquals("<img onerror=x>", text.text(), "stored as text; clients draw it on canvas, never as HTML");
    }

    @Test
    void ignoresClientSuppliedAuthor() {
        BoardElement element = service.parse(node("{\"id\":\"forge-01\",\"author\":\"victim\",\"kind\":\"pen\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0]}"), "me");
        assertEquals("me", element.author());
    }

    @Test
    void rejectsOversizedStrokes() {
        assertNotNull(stroke("max-0001", "me", WhiteboardService.MAX_STROKE_POINTS));
        assertThrows(InvalidMessageException.class, () -> stroke("max-0002", "me", WhiteboardService.MAX_STROKE_POINTS + 2));
        assertThrows(InvalidMessageException.class, () -> service.parse(node("{\"id\":\"txt-long1\",\"kind\":\"text\",\"color\":\"#000000\",\"size\":2,\"points\":[0,0],\"text\":\"" + "a".repeat(WhiteboardService.MAX_TEXT_LENGTH + 1) + "\"}"), "me"));
    }

    @Test
    void boardIsBoundedAndDropsUndoneWorkFirst() {
        Whiteboard board = new Whiteboard(3, 100);
        service.add(board, stroke("one-0001", "me", 40));
        service.add(board, stroke("two-0001", "me", 40));
        assertThrows(InvalidMessageException.class, () -> service.add(board, stroke("three-001", "me", 40)), "point budget");
        service.setHidden(board, "me", "two-0001", true);
        assertEquals(Whiteboard.AddResult.ADDED, service.add(board, stroke("three-001", "me", 40)));
        assertNull(board.find("two-0001"), "undone element was released");
        assertEquals(80, board.pointCount());
        board.clear();
        assertEquals(0, board.size());
        assertEquals(0, board.pointCount());
    }

    @Test
    void sequenceAdvancesOnlyForAcceptedChanges() {
        Whiteboard board = service.newBoard();
        service.add(board, stroke("seq-0001", "me", 4));
        assertEquals(Whiteboard.AddResult.DUPLICATE, service.add(board, stroke("seq-0001", "me", 4)));
        assertEquals(1, board.seq());
        assertFalse(service.setHidden(board, "me", "missing-1", true));
        assertFalse(service.setHidden(board, "me", "seq-0001", false), "redo of a visible element changes nothing");
        assertEquals(1, board.seq());
        assertThrows(InvalidMessageException.class, () -> service.setHidden(board, "other", "seq-0001", true));
        assertTrue(service.setHidden(board, "me", "seq-0001", true));
        assertEquals(2, board.seq());
        assertTrue(board.snapshot().getFirst().containsKey("hidden"));
    }
}
