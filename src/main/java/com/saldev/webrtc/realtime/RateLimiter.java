package com.saldev.webrtc.realtime;

import java.util.function.LongSupplier;

/** Per-participant token buckets. Limits are generous for real use and stop runaway clients. */
final class RateLimiter {
    enum Kind {
        // Initial ICE gathering to five peers can produce a burst of candidates.
        SIGNAL(400, 100),
        CHAT(8, 1),
        TYPING(3, 0.5),
        BOARD(40, 15),
        LIVE(90, 45),
        SYNC(3, 0.2);

        private final double capacity;
        private final double perSecond;

        Kind(double capacity, double perSecond) {
            this.capacity = capacity;
            this.perSecond = perSecond;
        }
    }

    private final LongSupplier nanoTime;
    private final double[] tokens = new double[Kind.values().length];
    private final long[] updated = new long[Kind.values().length];

    RateLimiter(LongSupplier nanoTime) {
        this.nanoTime = nanoTime;
        long now = nanoTime.getAsLong();
        for (Kind kind : Kind.values()) {
            tokens[kind.ordinal()] = kind.capacity;
            updated[kind.ordinal()] = now;
        }
    }

    boolean tryAcquire(Kind kind) {
        int index = kind.ordinal();
        long now = nanoTime.getAsLong();
        double refill = (now - updated[index]) / 1e9 * kind.perSecond;
        tokens[index] = Math.min(kind.capacity, tokens[index] + refill);
        updated[index] = now;
        if (tokens[index] < 1) return false;
        tokens[index] -= 1;
        return true;
    }
}
