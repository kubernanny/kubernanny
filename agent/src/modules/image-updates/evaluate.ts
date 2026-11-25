import { Issue } from '../../checks/types';
import { t, Text } from '../../i18n/text';

export interface SemverTag {
  /** "v" or "": candidates must be written the same way as the running tag. */
  prefix: string;
  nums: [number, number, number];
  tag: string;
}

/**
 * Only plain release tags: "1.2.3" or "v1.2.3". Anything with a suffix
 * (-alpine, -build2025…, -rc.1) is a flavour or a prerelease whose newer
 * equivalent cannot be told from a tag list; a four-digit major is a date.
 */
export function parseSemverTag(tag: string): SemverTag | null {
  const m = /^(v?)(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(tag);
  if (!m || /^(19|20|21)\d\d$/.test(m[2]!)) {
    return null;
  }
  return { prefix: m[1]!, nums: [Number(m[2]), Number(m[3]), Number(m[4])], tag };
}

const cmp = (a: SemverTag, b: SemverTag) => a.nums[0] - b.nums[0] || a.nums[1] - b.nums[1] || a.nums[2] - b.nums[2];

export interface Updates {
  /** Newest release of the same minor. */
  patch?: string;
  /** Newest release of the same major with a higher minor. */
  minor?: string;
  /** Newest release of a higher major. */
  major?: string;
}

/**
 * A major more than this far ahead is a stray tag (a mirror's own build
 * number, a test push), not a release anyone should be told about.
 */
const MAX_MAJOR_JUMP = 3;

export function availableUpdates(current: string, tags: readonly string[]): Updates {
  const cur = parseSemverTag(current);
  if (!cur) {
    return {};
  }
  const newer = tags
    .map(parseSemverTag)
    .filter((v): v is SemverTag => v !== null && v.prefix === cur.prefix && cmp(v, cur) > 0 && v.nums[0] - cur.nums[0] <= MAX_MAJOR_JUMP)
    .sort(cmp);
  const last = (f: (v: SemverTag) => boolean) => newer.filter(f).at(-1)?.tag;
  const [major, minor] = cur.nums;
  return {
    patch: last((v) => v.nums[0] === major && v.nums[1] === minor),
    minor: last((v) => v.nums[0] === major && v.nums[1] > minor),
    major: last((v) => v.nums[0] > major),
  };
}

/** One hint per component with something newer; never more than a hint: an upgrade is a decision, not a fault. */
export function imageUpdateIssue(component: { key: string; name: string; tag: string }, updates: Updates): Issue | null {
  const parts: Text[] = [];
  if (updates.patch) {
    parts.push(t('imageUpdates.patch', { version: updates.patch }));
  }
  if (updates.minor) {
    parts.push(t('imageUpdates.minor', { version: updates.minor }));
  }
  if (updates.major) {
    parts.push(t('imageUpdates.major', { version: updates.major }));
  }
  if (parts.length === 0) {
    return null;
  }
  return {
    id: `image-updates/${component.key}`,
    check: 'image-updates',
    severity: 'info',
    title: t('imageUpdates.title', { name: component.name, version: component.tag }),
    cause: t('common.sentences', { parts: [...parts, t(updates.major ? 'imageUpdates.releaseNotesMajor' : 'imageUpdates.releaseNotes')] }),
    actions: [],
  };
}
