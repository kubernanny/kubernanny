package app.kubernanny.push;

/**
 * The authenticity marker on an opened push (app/src/app/core/push/push-marker.ts,
 * `markedTitle`; the iOS extension's PushKeys.markedTitle is the same).
 * Only text this service opened gets it: a notification someone showed
 * through FCM without the app's code has no way to know it.
 */
final class PushMarker {
    private PushMarker() {}

    static String title(String marker, String title) {
        String m = marker == null ? "" : marker.trim();
        return m.isEmpty() ? title : m + " " + title;
    }
}
