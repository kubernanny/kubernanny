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
        System.out.println("PushFreshness.java: as pushFresh in push-content.ts");
    }

    private static void check(boolean actual, boolean expected) {
        if (actual != expected) {
            throw new AssertionError("expected " + expected + ", got " + actual);
        }
    }
}
