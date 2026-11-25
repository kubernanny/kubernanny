package app.kubernanny.push;

/** The same cases as push-marker.spec.ts. Plain JVM, no Android. */
public final class PushMarkerTest {
    public static void main(String[] args) {
        check(PushMarker.title("🦉", "homelab: 2 problems"), "🦉 homelab: 2 problems");
        check(PushMarker.title(" Kiwi ", "homelab: ok"), "Kiwi homelab: ok");
        check(PushMarker.title(null, "homelab: ok"), "homelab: ok");
        check(PushMarker.title("  ", "homelab: ok"), "homelab: ok");
        System.out.println("PushMarker.java: titles as in push-marker.ts");
    }

    private static void check(String actual, String expected) {
        if (!expected.equals(actual)) {
            throw new AssertionError("expected \"" + expected + "\", got \"" + actual + "\"");
        }
    }
}
