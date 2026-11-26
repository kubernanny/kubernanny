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
        System.out.println("PushFreshness.java: as pushFresh and statusPushFresh in push-content.ts");
    }

    private static void check(boolean actual, boolean expected) {
        if (actual != expected) {
            throw new AssertionError("expected " + expected + ", got " + actual);
        }
    }
}
