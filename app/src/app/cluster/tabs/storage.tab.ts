import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { IonSpinner } from '@ionic/angular/standalone';
import { StorageView, Tone } from '../../core/agent.model';
import { Loadable } from '../../core/cluster-data.store';
import { bytes, percent } from '../../core/format';
import { LanguageService } from '../../i18n/language.service';
import { Translator } from '../../i18n/translator';
import { Meter, usageTone } from '../../ui/meter';

export interface VolumeRow {
  key: string;
  name: string;
  namespace: string;
  tone: Tone;
  state: string;
  used: number | null;
  usageText: string;
  facts: string;
  usedBy: string;
}

export function volumeRows(view: StorageView | null, tr: Translator): VolumeRow[] {
  const lang = tr.lang;
  return (view?.volumes ?? [])
    .map((v) => {
      const share = v.used !== null && v.capacity > 0 ? v.used / v.capacity : null;
      const lh = v.longhorn?.robustness;
      const tone: Tone =
        v.phase === 'Lost' || lh === 'faulted' ? 'critical' : v.phase !== 'Bound' || lh === 'degraded' ? 'warning' : share !== null ? usageTone(share) : 'ok';
      const state = v.phase !== 'Bound' ? (v.phase ?? tr.t('storage.unknown')) : lh ? tr.t('storage.longhorn', { state: lh }) : tr.t('storage.bound');
      return {
        key: `${v.namespace}/${v.name}`,
        name: v.name,
        namespace: v.namespace,
        tone,
        state,
        used: share,
        usageText:
          v.used !== null
            ? tr.t('storage.usage', { used: bytes(v.used, lang), capacity: bytes(v.capacity, lang), percent: percent(share, lang) })
            : tr.t('storage.usageUnknown', { capacity: bytes(v.capacity, lang) }),
        facts: [v.storageClass, v.accessModes.join(', '), v.longhorn?.replicas ? tr.n('storage.replicas', v.longhorn.replicas) : null].filter(Boolean).join(', '),
        usedBy: v.usedBy.length ? tr.t('storage.usedBy', { pods: v.usedBy.join(', ') }) : tr.t('storage.unused'),
      };
    })
    .sort((a, b) => ['critical', 'warning', 'ok', 'muted'].indexOf(a.tone) - ['critical', 'warning', 'ok', 'muted'].indexOf(b.tone) || (b.used ?? -1) - (a.used ?? -1));
}

/** One line per StorageClass: provisioner, volumes, whether volumes can grow, reclaim policy. */
export function classRows(view: StorageView | null, tr: Translator): { name: string; isDefault: boolean; text: string }[] {
  return (view?.classes ?? []).map((c) => ({
    name: c.name,
    isDefault: c.isDefault,
    text: [c.provisioner, tr.n('storage.volumeCount', c.volumes), tr.t(c.expansion ? 'storage.expandable' : 'storage.notExpandable'), c.reclaimPolicy].filter(Boolean).join(', '),
  }));
}

@Component({
  selector: 'app-storage-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, Meter, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      @if (storage().loading && !storage().value) {
        <div class="page-spinner"><ion-spinner /></div>
      }
      @if (storage().value) {
        <h2>{{ t('storage.classes') }}</h2>
        <div class="classes">
          @for (c of classes(); track c.name) {
            <div class="class">
              <strong>{{ c.name }}</strong>
              @if (c.isDefault) {
                <span class="pill tone-ok">{{ t('storage.default') }}</span>
              }
              <span class="muted">{{ c.text }}</span>
            </div>
          }
        </div>
      }
      <h2>{{ t('storage.volumes') }}</h2>
      <ul>
        @for (v of rows(); track v.key) {
          <li [class]="'tone-' + v.tone">
            <div class="top">
              <div class="names">
                <strong>{{ v.name }}</strong>
                <span class="muted">{{ v.namespace }}, {{ v.facts }}</span>
              </div>
              <span class="pill">{{ v.state }}</span>
            </div>
            <app-meter [label]="t('storage.usageLabel')" [used]="v.used" [text]="v.usageText" />
            <span class="muted by">{{ v.usedBy }}</span>
          </li>
        }
      </ul>
      <p class="muted note">{{ t('storage.note') }}</p>
    </ng-container>
  `,
  styles: `
    h2 {
      font-size: 1.1rem;
      font-weight: 650;
      margin: 0 0 0.6rem;
    }
    .classes {
      display: grid;
      gap: 0.5rem;
      margin-bottom: 1.75rem;
    }
    .class {
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.75rem 0.9rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem 0.6rem;
      align-items: center;
    }
    .class .muted {
      flex-basis: 100%;
      font-size: 0.8125rem;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
      gap: 0.75rem;
    }
    li {
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.9rem 1rem;
      display: grid;
      gap: 0.7rem;
    }
    .top {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      align-items: start;
    }
    .names {
      display: grid;
      min-width: 0;
    }
    .names strong {
      overflow-wrap: anywhere;
    }
    .names .muted,
    .by {
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
    .note {
      font-size: 0.8125rem;
      margin-top: 1rem;
    }
  `,
})
export class StorageTab {
  readonly storage = input.required<Loadable<StorageView>>();
  private readonly language = inject(LanguageService);
  readonly rows = computed(() => volumeRows(this.storage().value, this.language.translator()));
  readonly classes = computed(() => classRows(this.storage().value, this.language.translator()));
}
