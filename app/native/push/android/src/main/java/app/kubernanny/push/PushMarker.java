package app.kubernanny.push;

import java.text.BreakIterator;

/**
 * The authenticity marker on an opened push (app/src/app/core/push/push-marker.ts,
 * `markedTitle`; the iOS extension's PushKeys.markedTitle is the same).
 * Only text this service opened gets it: a notification someone showed
 * through FCM without the app's code has no way to know it.
 */
final class PushMarker {
    static final int MIN_LENGTH = 3;
    static final int MAX_LENGTH = 12;

    private PushMarker() {}

    static String title(String marker, String title) {
        String m = marker == null ? "" : marker.trim();
        return m.isEmpty() ? title : m + " " + title;
    }

    /**
     * Mirrors `normalizeMarker` in push-marker.ts: the marker as stored, or
     * null when it cannot be one (3 to 12 characters as a person counts them,
     * no line break or other control or format character, the emoji joiner aside).
     */
    static String normalize(String input) {
        if (input == null) {
            return null;
        }
        String trimmed = input.trim();
        for (int i = 0; i < trimmed.length(); ) {
            int cp = trimmed.codePointAt(i);
            int type = Character.getType(cp);
            boolean format = type == Character.FORMAT && cp != 0x200D;
            if (type == Character.CONTROL || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR || format) {
                return null;
            }
            i += Character.charCount(cp);
        }
        String marker = trimmed.replaceAll("\\s+", " ");
        int length = graphemes(marker);
        return length >= MIN_LENGTH && length <= MAX_LENGTH ? marker : null;
    }

    private static int graphemes(String text) {
        BreakIterator it = BreakIterator.getCharacterInstance();
        it.setText(text);
        int count = 0;
        while (it.next() != BreakIterator.DONE) {
            count++;
        }
        return count;
    }
}
