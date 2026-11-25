import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { IonSpinner } from '@ionic/angular/standalone';
import { EventView } from '../../core/agent.model';
import { Loadable } from '../../core/cluster-data.store';
import { duration, relativeTime } from '../../core/format';
import { LanguageService } from '../../i18n/language.service';
import { Translator } from '../../i18n/translator';

export interface EventRow {
  key: string;
  time: string;
  when: string;
  reason: string;
  object: string;
  /** "Deployment api": the workload behind a pod or ReplicaSet; empty when the event is about the workload itself or none is known. */
  workload: string;
  message: string;
  /** "35× seit 39 min", "14×", or null for a single event. */
  repeat: string | null;
  /** "2 Kubernetes-Events zusammengefasst" when the agent merged rows, else null. */
  merged: string | null;
}

/** One line per object and reason; how often, and since Kubernetes first saw it. */
export function eventRows(events: EventView[], now: Date, tr: Translator): EventRow[] {
  return events.map((e, index) => {
    const since = e.firstSeen ? duration(e.firstSeen, now, tr.lang) : null;
    return {
      key: `${index}:${e.time}`,
      time: e.time,
      when: relativeTime(e.time, now, tr.lang),
      reason: e.reason ?? '',
      object: [e.kind, e.namespace ? `${e.namespace}/${e.name}` : e.name].filter(Boolean).join(' '),
      message: e.message ?? '',
      workload: e.workload && !(e.workload.kind === e.kind && e.workload.name === e.name) ? tr.t('events.workload', { kind: e.workload.kind, name: e.workload.name }) : '',
      repeat: e.count > 1 ? (since ? tr.t('events.repeated', { count: e.count, span: since }) : `${e.count}×`) : null,
      merged: (e.events ?? 1) > 1 ? tr.t('events.merged', { count: e.events ?? 1 }) : null,
    };
  });
}

@Component({
  selector: 'app-events-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      <p class="muted intro">{{ t('events.intro') }}</p>
      @if (events().loading && !events().value) {
        <div class="page-spinner"><ion-spinner /></div>
      }
      <ol>
        @for (e of rows(); track e.key) {
          <li>
            <time [attr.datetime]="e.time">{{ e.when }}</time>
            <div class="body">
              <div class="head">
                <strong>{{ e.reason }}</strong>
                <span class="muted">{{ e.object }}</span>
                @if (e.repeat) {
                  <span class="pill tone-muted" [attr.title]="e.merged">{{ e.repeat }}</span>
                }
              </div>
              <p>{{ e.message }}</p>
              @if (e.workload) {
                <span class="muted workload">{{ e.workload }}</span>
              }
            </div>
          </li>
        } @empty {
          @if (events().value) {
            <li class="muted">{{ t('events.none') }}</li>
          }
        }
      </ol>
    </ng-container>
  `,
  styles: `
    .workload {
      display: block;
      font-size: 0.8125rem;
      margin-top: 0.2rem;
    }
    .intro {
      font-size: 0.9375rem;
      margin: 0 0 1.25rem;
    }
    ol {
      list-style: none;
      margin: 0;
      padding: 0;
      border-left: 2px solid var(--line);
    }
    li {
      position: relative;
      padding: 0 0 1.25rem 1.1rem;
    }
    li::before {
      content: '';
      position: absolute;
      left: -6px;
      top: 0.35rem;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--warn);
      box-shadow: 0 0 0 3px var(--ground);
    }
    time {
      color: var(--mute);
      font-size: 0.8125rem;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: baseline;
      margin-top: 0.15rem;
    }
    .head .muted {
      font-size: 0.875rem;
      overflow-wrap: break-word;
    }
    p {
      margin: 0.25rem 0 0;
      color: var(--ink-2);
      font-size: 0.9375rem;
      line-height: 1.45;
      overflow-wrap: break-word;
    }
  `,
})
export class EventsTab {
  readonly events = input.required<Loadable<EventView[]>>();
  readonly now = input.required<Date>();
  private readonly language = inject(LanguageService);
  readonly rows = computed(() => eventRows(this.events().value ?? [], this.now(), this.language.translator()));
}
