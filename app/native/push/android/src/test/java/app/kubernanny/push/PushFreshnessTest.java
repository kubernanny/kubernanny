package app.kubernanny.push;

/** The same cases as pushFresh in push.spec.ts. Plain JVM, no Android. */
public final class PushFreshnessTest {
    public static void main(String[] args) {
        long now = 1_795_000_000_000L;
        long hour = PushFreshness.MAX_AGE_MS;
        check(PushFreshness.fresh(now - 5_000, now, null), true);
        check(PushFreshness.fresh(now - 5_000, now, now - 60_000), true);
        check(PushFreshness.fresh(now - hour, now, null), true);
        check(PushFreshness.fresh(now - hour - 1, now, null), false);
        check(PushFreshness.fresh(now - 60_000, now, now - 60_000), false);
        check(PushFreshness.fresh(now - 60_000, now, now - 5_000), false);
        check(PushFreshness.fresh(now + hour + 1, now, null), false);
        // Status pushes: within the hour, whatever was shown before; and only priority 0 is one.
        check(PushFreshness.statusFresh(now - 5_000, now), true);
        check(PushFreshness.statusFresh(now - hour, now), true);
        check(PushFreshness.statusFresh(now - hour - 1, now), false);
        check(PushFreshness.statusFresh(now + hour + 1, now), false);
        check(PushFreshness.isStatusOnly(0), true);
        check(PushFreshness.isStatusOnly(2), false);
        check(PushFreshness.isStatusOnly(5), false);
        // Dead man's switch messages: the same cases as deadmanFresh in push.spec.ts.
        long s = 1_795_000_000_000L;
        long min = 60_000L;
        long u = s + 3 * hour;
        check(PushFreshness.deadmanFresh(s, u, 15, s + 2 * hour, null, null), true);
        check(PushFreshness.deadmanFresh(s, u, 15, s + 90 * min, null, s - 10 * min), true);
        check(PushFreshness.deadmanFresh(s, u, 15, s + 90 * min, null, s + 20 * min), true);
        check(PushFreshness.deadmanFresh(s, u, 15, s + 90 * min, s, null), false);
        check(PushFreshness.deadmanFresh(s, u, 15, u + 1, null, null), false);
        check(PushFreshness.deadmanFresh(s + 2 * hour, u, 15, s, null, null), false);
        check(PushFreshness.deadmanFresh(s, s + 28 * hour, 15, s + min, null, null), false);
        check(PushFreshness.deadmanFresh(s, u, 15, s + 90 * min, null, s + 80 * min), false);
        check(PushFreshness.validGrace(15), true);
        check(PushFreshness.validGrace(20), false);
        System.out.println("PushFreshness.java: as pushFresh, statusPushFresh and deadmanFresh in push-content.ts");
    }

    private static void check(boolean actual, boolean expected) {
        if (actual != expected) {
            throw new AssertionError("expected " + expected + ", got " + actual);
        }
    }
}
