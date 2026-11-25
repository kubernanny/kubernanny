import { TextError, t } from '../../i18n/text';
import { Detected } from '../../discovery/discovery';
import { KubeClient } from '../../kube/kube-client';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';
import { availableUpdates, imageUpdateIssue, parseSemverTag } from './evaluate';
import { ImageRef, parseImageRef, REGISTRIES } from './image-ref';
import { TagSource } from './registry-client';
import { tagSourceFor } from './tag-source';

interface Target {
  key: string;
  name: string;
  ref: ImageRef;
}

/** Recognised components whose image has a plain release tag on a supported registry; the rest is counted. */
export function updateTargets(detected: Detected[]): { targets: Target[]; skipped: number } {
  const targets: Target[] = [];
  let skipped = 0;
  for (const d of detected) {
    const ref = d.image && !d.entry.custom ? parseImageRef(d.image) : null;
    if (!ref || !parseSemverTag(ref.tag)) {
      skipped++;
      continue;
    }
    targets.push({ key: d.entry.id, name: d.entry.name, ref });
  }
  return { targets, skipped };
}

const CONCURRENCY = 4;

/**
 * Newer releases of recognised components, as hints. Off by default: it
 * asks public registries for tag lists (docs/SECURITY-CHECKS.md lists the
 * hosts). Switched off, it never runs, so no registry is ever contacted.
 */
export class ImageUpdatesCheck extends CoreCheck {
  readonly id = 'image-updates';
  readonly name = t('module.imageUpdates.name');
  readonly icon = 'arrow-up-circle-outline';
  readonly description = t('module.imageUpdates.description');
  readonly reads = [];
  override readonly defaultOff = true;
  /** One per cluster client, kept across runs: its cache is what limits the module to two lookups a day per image. */
  private readonly sources = new WeakMap<KubeClient, TagSource>();

  constructor(private readonly sourceFor: (kube: KubeClient) => TagSource = tagSourceFor) {
    super();
  }

  override privacy() {
    return t('imageUpdates.privacy', { hosts: REGISTRIES.map((r) => r.name).join(', ') });
  }

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const source = this.sources.get(ctx.kube) ?? this.sourceFor(ctx.kube);
    this.sources.set(ctx.kube, source);
    const { targets, skipped } = updateTargets(ctx.detected ?? []);
    const answers: (string[] | null)[] = [];
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = await Promise.allSettled(targets.slice(i, i + CONCURRENCY).map((x) => source.tags(x.ref, ctx.now)));
      answers.push(...batch.map((r) => (r.status === 'fulfilled' ? r.value : null)));
    }
    const failed = answers.filter((a) => a === null).length;
    if (targets.length > 0 && failed === targets.length) {
      throw new TextError(t('imageUpdates.unreachable'));
    }
    const issues = targets.map((x, i) => (answers[i] ? imageUpdateIssue({ key: x.key, name: x.name, tag: x.ref.tag }, availableUpdates(x.ref.tag, answers[i]!)) : null)).filter((i) => i !== null);
    return {
      issues,
      stats: [
        { label: t('imageUpdates.stat.checked'), value: String(targets.length - failed) },
        { label: t('imageUpdates.stat.newer'), value: String(issues.length), tone: issues.length ? 'muted' : 'ok' },
        { label: t('imageUpdates.stat.skipped'), value: String(skipped), tone: 'muted' },
        ...(failed ? [{ label: t('imageUpdates.stat.failed'), value: String(failed), tone: 'warning' as const }] : []),
      ],
      summary: issues.length ? t('imageUpdates.summary.newer', { n: issues.length }) : t('imageUpdates.summary.none', { n: targets.length - failed }),
    };
  }
}
