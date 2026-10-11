package com.saldev.webrtc.service;

import java.util.regex.Pattern;

/** Normalization shared by every user-provided string that other participants see. */
public final class TextRules {
    public static final int MAX_NAME_LENGTH = 40;

    // Control characters, bidirectional overrides/isolates and line/paragraph separators can
    // disguise or reorder text. Zero-width joiners stay because emoji sequences need them.
    private static final Pattern UNSAFE = Pattern.compile("[\\p{Cc}\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\p{Zl}\\p{Zp}]");
    private static final Pattern UNSAFE_EXCEPT_NEWLINE = Pattern.compile("[\\p{Cc}\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\p{Zl}\\p{Zp}&&[^\\n]]");
    private static final Pattern SPACES = Pattern.compile("[\\s\\u00A0]+");
    private static final Pattern EXTRA_BLANK_LINES = Pattern.compile("\\n{3,}");

    private TextRules() {
    }

    /** A single-line display name, or an empty string when nothing usable remains. */
    public static String displayName(String raw) {
        if (raw == null) return "";
        String bounded = raw.substring(0, Math.min(raw.length(), 200));
        return SPACES.matcher(UNSAFE.matcher(bounded).replaceAll(" ")).replaceAll(" ").strip();
    }

    /** Multi-line message text with normalized line endings; length is checked by the caller. */
    public static String messageText(String raw, int boundChars) {
        if (raw == null) return "";
        String bounded = raw.substring(0, Math.min(raw.length(), boundChars));
        String text = bounded.replace("\r\n", "\n").replace('\r', '\n').replace('\t', ' ');
        text = UNSAFE_EXCEPT_NEWLINE.matcher(text).replaceAll("");
        return EXTRA_BLANK_LINES.matcher(text).replaceAll("\n\n").strip();
    }

    public static int length(String value) {
        return value.codePointCount(0, value.length());
    }
}
