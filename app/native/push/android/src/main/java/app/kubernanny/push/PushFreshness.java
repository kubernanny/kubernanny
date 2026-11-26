package app.kubernanny.push;

/**
 * Whether an opened push may be shown: its sealed time `s` lies within an
 * hour of the phone's clock and is later than the last push shown for its
 * key. Whoever relays pushes can record one and send it again; without this
 * a recorded "all fine" could cover a later problem (docs/PROTOCOL.md,
 * "Push replay"). Mirrors `pushFresh` in app/src/app/core/push/push-content.ts
 * and PushKeys.isFresh in the iOS extension; keep the three identical.
 */
final class PushFreshness {
    static final long MAX_AGE_MS = 60L * 60L * 1000L;

    private PushFreshness() {}

    /** `lastShown` is null when no push of this key was shown yet. */
    static boolean fresh(long sealedAt, long now, Long lastShown) {
        if (Math.abs(now - sealedAt) > MAX_AGE_MS) {
            return false;
        }
        return lastShown == null || sealedAt > lastShown;
    }

    /** The priority of a status push: it carries only the widget's state and is never shown (PUSH_STATUS_ONLY in protocol/src/push.ts). */
    static final int STATUS_ONLY = 0;

    static boolean isStatusOnly(int priority) {
        return priority == STATUS_ONLY;
    }

    /**
     * A status push is applied when sealed within the hour; it is not compared
     * with, and does not move, the last push shown, so it never hides an alert.
     */
    static boolean statusFresh(long sealedAt, long now) {
        return Math.abs(now - sealedAt) <= MAX_AGE_MS;
    }

    /** The longest validity a dead man's switch message may carry (DEADMAN_MAX_VALIDITY_MS in protocol/src/push.ts). */
    static final long DEADMAN_MAX_VALIDITY_MS = 27L * 60L * 60L * 1000L;

    /**
     * Whether a dead man's switch message (sealed ahead of time, sent by the
     * relay when the agent went silent) may be shown: the phone's clock within
     * its window `validUntil`, not sealed more than an hour ahead, later than
     * the last such message shown for its key (a replay marker of its own),
     * and no push of this agent opened within the grace (`lastHeard`).
     * Mirrors deadmanFresh in push-content.ts and PushKeys.isDeadmanFresh.
     */
    static boolean deadmanFresh(long sealedAt, long validUntil, int graceMinutes, long now, Long lastDeadman, Long lastHeard) {
        if (sealedAt - now > MAX_AGE_MS || now > validUntil || validUntil - sealedAt > DEADMAN_MAX_VALIDITY_MS) {
            return false;
        }
        if (lastDeadman != null && sealedAt <= lastDeadman) {
            return false;
        }
        return lastHeard == null || lastHeard < now - graceMinutes * 60_000L;
    }

    /** The graces the protocol allows (DEADMAN_GRACE_MINUTES); anything else is not a dead man's switch message. */
    static boolean validGrace(int minutes) {
        return minutes == 10 || minutes == 15 || minutes == 30 || minutes == 60;
    }
}
