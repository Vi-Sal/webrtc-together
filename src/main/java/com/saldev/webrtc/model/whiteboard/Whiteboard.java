package com.saldev.webrtc.model.whiteboard;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Server-ordered whiteboard state for one room. Every accepted change increments {@link #seq()},
 * so clients can detect gaps. Undone elements keep their position, letting redo restore the
 * original stacking order. Not thread-safe; guarded by the room handler.
 */
public final class Whiteboard {
    private final int maxElements;
    private final int maxPoints;
    private final LinkedHashMap<String, Entry> elements = new LinkedHashMap<>();
    private long seq;
    private int pointCount;

    private static final class Entry {
        private final BoardElement element;
        private boolean hidden;

        private Entry(BoardElement element) {
            this.element = element;
        }
    }

    public enum AddResult { ADDED, DUPLICATE, FULL }

    public Whiteboard(int maxElements, int maxPoints) {
        this.maxElements = maxElements;
        this.maxPoints = maxPoints;
    }

    public long seq() {
        return seq;
    }

    public int size() {
        return elements.size();
    }

    public int pointCount() {
        return pointCount;
    }

    public AddResult add(BoardElement element) {
        if (elements.containsKey(element.id())) return AddResult.DUPLICATE;
        if (!fits(element)) dropHidden();
        if (!fits(element)) return AddResult.FULL;
        elements.put(element.id(), new Entry(element));
        pointCount += element.points().length;
        seq++;
        return AddResult.ADDED;
    }

    /** Hides or restores an element owned by {@code author}; returns false when nothing changed. */
    public boolean setHidden(String id, String author, boolean hidden) {
        Entry entry = elements.get(id);
        if (entry == null || !entry.element.author().equals(author) || entry.hidden == hidden) return false;
        entry.hidden = hidden;
        seq++;
        return true;
    }

    public BoardElement find(String id) {
        Entry entry = elements.get(id);
        return entry == null ? null : entry.element;
    }

    public void clear() {
        elements.clear();
        pointCount = 0;
        seq++;
    }

    public List<Map<String, Object>> snapshot() {
        List<Map<String, Object>> list = new ArrayList<>(elements.size());
        for (Entry entry : elements.values()) list.add(entry.element.toJson(entry.hidden));
        return list;
    }

    private boolean fits(BoardElement element) {
        return elements.size() < maxElements && pointCount + element.points().length <= maxPoints;
    }

    // Undone work is the first thing given up when the board reaches its memory bound.
    private void dropHidden() {
        for (Iterator<Entry> iterator = elements.values().iterator(); iterator.hasNext(); ) {
            Entry entry = iterator.next();
            if (entry.hidden) {
                pointCount -= entry.element.points().length;
                iterator.remove();
            }
        }
    }
}
