package com.saldev.webrtc.service;

/**
 * A realtime message that failed validation. The message text is safe to return to the sender;
 * {@code code} names the affected feature and {@code ref} echoes the client operation ID.
 */
public class InvalidMessageException extends RuntimeException {
    private final String code;
    private final String ref;

    public InvalidMessageException(String message) {
        this(message, null, null);
    }

    public InvalidMessageException(String message, String code, String ref) {
        super(message);
        this.code = code;
        this.ref = ref;
    }

    public String code() {
        return code;
    }

    public String ref() {
        return ref;
    }
}
