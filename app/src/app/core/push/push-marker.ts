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

/**
 * The pool suggestions are drawn from: 64 single-code-point emoji that look
 * alike nowhere (no skin tones, no flags, no joiner sequences). A suggestion
 * is three of them, 64 × 63 × 62 = 249,984 possibilities, so a forger who
 * guesses is wrong on almost every phone. A single emoji from a short list
 * would be right one time in eight.
 */
export const MARKER_POOL = [
  '🦉',
  '🦊',
  '🐙',
  '🌵',
  '🍀',
  '🐝',
  '🌻',
  '⚓',
  '🦋',
  '🐢',
  '🦀',
  '🐳',
  '🦒',
  '🦔',
  '🦜',
  '🐌',
  '🍄',
  '🌙',
  '⭐',
  '🔥',
  '🌈',
  '❄️',
  '🍋',
  '🍒',
  '🍉',
  '🥕',
  '🌽',
  '🍩',
  '🧀',
  '🥨',
  '🍕',
  '☕',
  '🎈',
  '🎲',
  '🎸',
  '🎺',
  '🥁',
  '🪁',
  '🧩',
  '🪀',
  '🚲',
  '🛶',
  '🚀',
  '🛸',
  '⛵',
  '🏰',
  '🗿',
  '🌋',
  '🔑',
  '🧭',
  '⏰',
  '🔭',
  '🧲',
  '💎',
  '🪴',
  '🕯️',
  '📎',
  '✂️',
  '🧵',
  '🪶',
  '🐚',
  '🍂',
  '🌊',
  '🧊',
] as const;

/** How many emoji a suggestion has. */
export const SUGGESTION_SIZE = 3;
/** An own word must be at least this long: a single letter or emoji is guessed too easily. */
export const MIN_MARKER_LENGTH = 3;
export const MAX_MARKER_LENGTH = 12;

/** Three different emoji from the pool, drawn with the platform's cryptographic randomness. */
export function suggestMarker(randomIndex: (n: number) => number = cryptoIndex): string {
  const pool: string[] = [...MARKER_POOL];
  const picked: string[] = [];
  for (let i = 0; i < SUGGESTION_SIZE; i++) {
    picked.push(pool.splice(randomIndex(pool.length) % pool.length, 1)[0]!);
  }
  return picked.join('');
}

/** A uniform index below n (rejection sampling, so no index is favoured). */
function cryptoIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0]! >= limit);
  return buf[0]! % n;
}

/**
 * What the person typed, made into a marker, or null when it cannot be one:
 * shorter than 3 or longer than 12 characters (counted as a person sees them, so a
 * family emoji is one), or holding a line break or another control
 * character (those would let a marker hide inside a title).
 */
export function normalizeMarker(input: string): string | null {
  const trimmed = input.trim();
  // Checked before spaces are collapsed (\s also matches line separators). Zero width joiner stays: emoji sequences are built with it.
  if (
    !trimmed ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmed) ||
    /[\p{Cf}]/u.test(trimmed.replace(/‍/g, ''))
  ) {
    return null;
  }
  const marker = trimmed.replace(/\s+/g, ' ');
  const length = characters(marker);
  return length >= MIN_MARKER_LENGTH && length <= MAX_MARKER_LENGTH ? marker : null;
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
