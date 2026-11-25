import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { BackupsView } from '../../core/agent.model';
import { Loadable } from '../../core/cluster-data.store';
import { LanguageService } from '../../i18n/language.service';
import { backupsView } from '../backups-view';

/** Every backup Kubernanny knows, by tool; where they go; what has none. */
@Component({
  selector: 'app-backups-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonIcon, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      @if (backups().loading && !backups().value) {
        <div class="page-spinner"><ion-spinner /></div>
      } @else if (backups().error && !backups().value) {
        <p class="error">{{ backups().error }}</p>
      } @else if (vm(); as v) {
        @if (v.empty) {
          <div class="empty">
            <ion-icon name="archive-outline" aria-hidden="true" />
            <strong>{{ t('backups.emptyTitle') }}</strong>
            <p class="muted">{{ t('backups.emptyText') }}</p>
          </div>
        } @else {
          @if (v.summary) {
            <p [class]="'summary tone-' + v.summaryTone">{{ v.summary }}</p>
          }
          <p class="muted intro">{{ v.intro }}</p>

          @for (g of v.groups; track g.kind) {
            <section>
              <h2>{{ g.product }} <span class="what">{{ g.what }}</span></h2>
              <ul class="rows">
                @for (l of g.lines; track l.id) {
                  <li [class]="'tone-' + l.tone">
                    <div class="top">
                      <span class="name">
                        <strong>{{ l.name }}</strong>
                        @if (l.namespace) {
                          <span class="muted">{{ l.namespace }}</span>
                        }
                      </span>
                      <span class="pill">{{ l.state }}</span>
                    </div>
                    <span class="last">{{ l.last }}</span>
                    @if (l.note) {
                      <span class="note">{{ l.note }}</span>
                    }
                    @if (l.target || l.count) {
                      <span class="muted facts">
                        @if (l.target) {
                          <span class="target">{{ l.target }}</span>
                        }
                        @if (l.count) {
                          <span>{{ l.count }}</span>
                        }
                      </span>
                    }
                  </li>
                }
              </ul>
            </section>
          }

          @if (v.targets.length > 0) {
            <section>
              <h2>{{ t('backups.targets') }}</h2>
              <ul class="rows">
                @for (x of v.targets; track x.name) {
                  <li [class]="'tone-' + x.tone">
                    <div class="top">
                      <span class="name"><strong>{{ x.name }}</strong></span>
                      <span class="pill">{{ x.availability }}</span>
                    </div>
                    <span class="muted target">{{ x.text }}</span>
                  </li>
                }
              </ul>
            </section>
          }

          @if (v.unprotected.length > 0) {
            <section class="unprotected">
              <h2>{{ t('backups.unprotected') }} <span class="what">{{ v.unprotected.length }}</span></h2>
              <p class="muted intro">{{ t('backups.unprotectedIntro') }}</p>
              <ul>
                @for (u of v.unprotected; track u.key) {
                  <li><span class="kind">{{ u.kind }}</span><span class="uname">{{ u.name }}</span></li>
                }
              </ul>
            </section>
          }

          @if (v.orphaned) {
            <p class="muted orphaned">{{ v.orphaned }}</p>
          }
        }
      }
    </ng-container>
  `,
  styles: `
    .orphaned {
      font-size: 0.8125rem;
      margin: 1.25rem 0 0;
    }
    .summary {
      font-family: var(--font-display);
      font-size: 1.15rem;
      font-weight: 650;
      color: var(--tone);
      margin: 0 0 0.3rem;
    }
    .intro {
      font-size: 0.875rem;
      margin: 0 0 1.25rem;
    }
    section {
      margin-bottom: 1.75rem;
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 650;
      margin: 0 0 0.6rem;
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .what {
      color: var(--mute);
      font-family: var(--font-body);
      font-size: 0.875rem;
      font-weight: 500;
    }
    .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
      gap: 0.6rem;
    }
    .rows li {
      display: grid;
      align-content: start;
      gap: 0.25rem;
      padding: 0.8rem 0.95rem;
      background: var(--surface);
      border-radius: var(--radius-m);
      box-shadow: inset 3px 0 0 var(--tone);
      min-width: 0;
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.75rem;
    }
    .name {
      display: grid;
      min-width: 0;
      overflow-wrap: break-word;
    }
    .name .muted {
      font-size: 0.8125rem;
    }
    .pill {
      flex: none;
    }
    .last {
      font-size: 0.9375rem;
    }
    .note {
      color: var(--tone);
      font-size: 0.875rem;
      font-weight: 600;
    }
    .facts {
      display: flex;
      flex-wrap: wrap;
      gap: 0.15rem 0.75rem;
      font-size: 0.8125rem;
    }
    .target {
      overflow-wrap: break-word;
      font-size: 0.8125rem;
    }
    .unprotected ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.35rem;
    }
    .unprotected li {
      display: grid;
      grid-template-columns: 5.5rem minmax(0, 1fr);
      gap: 0.75rem;
      align-items: baseline;
      font-size: 0.9375rem;
    }
    .uname {
      overflow-wrap: break-word;
    }
    .kind {
      color: var(--mute);
      font-size: 0.8125rem;
    }
    .empty {
      display: grid;
      justify-items: center;
      text-align: center;
      gap: 0.5rem;
      max-width: 30rem;
      margin: 2rem auto;
    }
    .empty ion-icon {
      font-size: 2.25rem;
      color: var(--mute);
    }
    .empty p {
      margin: 0;
      line-height: 1.5;
    }
  `,
})
export class BackupsTab {
  readonly backups = input.required<Loadable<BackupsView>>();
  readonly now = input.required<Date>();
  private readonly language = inject(LanguageService);
  readonly vm = computed(() => (this.backups().value || !this.backups().loading ? backupsView(this.backups().value, this.now(), this.language.translator()) : null));
}
