/**
 * The authenticity marker of native push (docs/NOTIFICATIONS.md, "Is this
 * push real?"). Whoever holds the relay's Firebase credentials can make a
 * phone show a notification without Kubernanny's code ever running (an FCM
 * notification message on Android, an APNs alert without mutable-content on
 * iOS). They cannot know this marker: it is picked on the device, kept only
 * next to the push keys (shared keychain group / Keystore-encrypted
 * preferences) and never sent anywhere. Every push the phone opens is shown
 * with it, so a push without it did not come from the person's cluster.
 *
 * `markedTitle` is mirrored by PushMarker.java (Android service) and
 * PushKeys.markedTitle (iOS extension); keep the three identical.
 */

/** The quick choices; anything else goes through "own word". */
export const MARKER_CHOICES = ['🦉', '🦊', '🐙', '🌵', '🍀', '🐝', '🌻', '⚓'] as const;

export const MAX_MARKER_LENGTH = 12;

/** A random quick choice, so not every phone starts with the same marker. */
export function suggestMarker(random: () => number = Math.random): string {
  return MARKER_CHOICES[Math.min(MARKER_CHOICES.length - 1, Math.floor(random() * MARKER_CHOICES.length))]!;
}

/**
 * What the person typed, made into a marker, or null when it cannot be one:
 * empty, longer than 12 characters (counted as a person sees them, so a
 * family emoji is one), or holding a line break or another control
 * character (those would let a marker hide inside a title).
 */
export function normalizeMarker(input: string): string | null {
  const trimmed = input.trim();
  // Checked before spaces are collapsed (\s also matches line separators). Zero width joiner stays: emoji sequences are built with it.
  if (!trimmed || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmed) || /[\p{Cf}]/u.test(trimmed.replace(/‍/g, ''))) {
    return null;
  }
  const marker = trimmed.replace(/\s+/g, ' ');
  return characters(marker) <= MAX_MARKER_LENGTH ? marker : null;
}

/** The title a successfully opened push is shown with. No marker (none chosen yet): the title as it is. */
export function markedTitle(marker: string | null | undefined, title: string): string {
  const m = marker?.trim();
  return m ? `${m} ${title}` : title;
}

function characters(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
  }
  return Array.from(text).length;
}
