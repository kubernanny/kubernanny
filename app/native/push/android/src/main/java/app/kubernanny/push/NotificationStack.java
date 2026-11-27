package app.kubernanny.push;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Which notifications of one cluster stay. Every push is a notification of its
 * own, stacked under the cluster (one group with a summary), so a resolution
 * does not wipe the alert before it; past {@link #KEEP} the oldest go, so a
 * flapping cluster cannot fill the shade. Plain Java, so a JVM test runs it
 * without Android (NotificationStackTest).
 */
final class NotificationStack {
    /** Notifications kept per cluster, the summary not counted. */
    static final int KEEP = 10;
    /** The summary's id; a push's id comes from its time ({@link #idFor}). */
    static final int SUMMARY_ID = 0;

    private NotificationStack() {}

    /** One shown notification of the cluster: its id and when it was posted (ms). */
    static final class Shown {
        final int id;
        final long when;

        Shown(int id, long when) {
            this.id = id;
            this.when = when;
        }
    }

    /**
     * The id of a push's notification: its sealed time in seconds, so the same
     * push shown twice (it never is: PushFreshness) would replace itself, and
     * pushes of one cluster get ids of their own. Never the summary's.
     */
    static int idFor(long when) {
        int id = (int) ((when / 1000L) & 0x7fffffff);
        return id == SUMMARY_ID ? 1 : id;
    }

    /** The ids to cancel so that at most {@link #KEEP} remain, the oldest first; the summary is never among them. */
    static List<Integer> toCancel(List<Shown> shown) {
        List<Shown> pushes = new ArrayList<>();
        for (Shown s : shown) {
            if (s.id != SUMMARY_ID) {
                pushes.add(s);
            }
        }
        pushes.sort(Comparator.comparingLong((Shown s) -> s.when).reversed());
        List<Integer> out = new ArrayList<>();
        for (int i = KEEP; i < pushes.size(); i++) {
            out.add(pushes.get(i).id);
        }
        return out;
    }
}
