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
}
