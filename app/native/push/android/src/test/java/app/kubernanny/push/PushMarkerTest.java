package app.kubernanny.push;

/** The same cases as push-marker.spec.ts. Plain JVM, no Android. */
public final class PushMarkerTest {
    public static void main(String[] args) {
        check(PushMarker.title("🦉", "homelab: 2 problems"), "🦉 homelab: 2 problems");
        check(PushMarker.title(" Kiwi ", "homelab: ok"), "Kiwi homelab: ok");
        check(PushMarker.title(null, "homelab: ok"), "homelab: ok");
        check(PushMarker.title("  ", "homelab: ok"), "homelab: ok");
        // normalizeMarker in push-marker.ts: 3 to 12 characters as a person counts them.
        check(PushMarker.normalize("🦉🦊🐙"), "🦉🦊🐙");
        check(PushMarker.normalize("  Kiwi  bird "), "Kiwi bird");
        check(PushMarker.normalize("ab"), null);
        check(PushMarker.normalize("🦉🦊"), null);
        check(PushMarker.normalize("abcdefghijklm"), null);
        check(PushMarker.normalize("abcdefghijkl"), "abcdefghijkl");
        check(PushMarker.normalize("Ki\nwi"), null);
        check(PushMarker.normalize("Ki\u202Ewi"), null);
        check(PushMarker.normalize(null), null);
        System.out.println("PushMarker.java: titles and markers as in push-marker.ts");
    }

    private static void check(String actual, String expected) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("expected \"" + expected + "\", got \"" + actual + "\"");
        }
    }
}
