package app.kubernanny.push;

import java.util.ArrayList;
import java.util.List;

/** Which notifications of a cluster stay. Plain JVM, no Android. */
public final class NotificationStackTest {
    public static void main(String[] args) {
        // Ids from the sealed time in seconds, never the summary's.
        check(NotificationStack.idFor(1_795_000_000_123L), 1_795_000_000);
        check(NotificationStack.idFor(999L), 1);
        check(NotificationStack.idFor(1_795_000_001_000L) != NotificationStack.idFor(1_795_000_000_000L), true);

        // Up to KEEP: nothing goes.
        List<NotificationStack.Shown> shown = new ArrayList<>();
        shown.add(new NotificationStack.Shown(NotificationStack.SUMMARY_ID, 0L));
        for (int i = 1; i <= NotificationStack.KEEP; i++) {
            shown.add(new NotificationStack.Shown(100 + i, i * 1000L));
        }
        check(NotificationStack.toCancel(shown).isEmpty(), true);

        // Three more: the three oldest go, never the summary.
        for (int i = 11; i <= 13; i++) {
            shown.add(new NotificationStack.Shown(100 + i, i * 1000L));
        }
        check(NotificationStack.toCancel(shown).toString(), "[103, 102, 101]");
        System.out.println("NotificationStack.java: one notification per push, at most " + NotificationStack.KEEP + " per cluster");
    }

    private static void check(Object actual, Object expected) {
        if (!expected.equals(actual)) {
            throw new AssertionError("expected " + expected + ", got " + actual);
        }
    }
}
