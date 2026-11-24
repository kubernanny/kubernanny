import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonToolbar, ModalController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { ClusterConfig, ModuleView } from '../core/agent.model';
import { STATUS_TONE } from '../core/format';
import { LanguageService } from '../i18n/language.service';
import { IssueList } from '../ui/issue-list';
import { IssueCard, moduleRow } from './cluster-view';

/** Everything Kubernanny knows about one component: its numbers, its problems, its pods and where to open it. */
@Component({
  selector: 'app-module-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonHeader, IonToolbar, IonButtons, IonButton, IonContent, IonIcon, IssueList],
  template: `
    <ng-container *transloco="let t">
      <ion-header>
        <ion-toolbar>
          <ion-buttons slot="end">
            <ion-button (click)="close()">{{ t('common.close') }}</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <header [class]="'tone-' + tone">
          <span class="icon"><ion-icon [name]="module.icon" aria-hidden="true" /></span>
          <div>
            <h1 class="display">{{ module.name }}</h1>
            <p class="muted">{{ module.description }}</p>
          </div>
        </header>
        <p [class]="'summary tone-' + tone"><span class="pill">{{ statusLabel }}</span> {{ module.summary }}</p>
        @if (module.error) {
          <p class="error">{{ t('module.checkFailed', { error: module.error }) }}</p>
        }

        @if (module.links.length > 0) {
          <div class="links">
            @for (link of module.links; track link.url) {
              <a [href]="link.url" target="_blank" rel="noopener">
                <ion-icon name="open-outline" aria-hidden="true" />
                {{ link.label }}
              </a>
            }
          </div>
        }

        @if (module.stats.length > 0) {
          <dl class="stats">
            @for (s of module.stats; track s.label) {
              <div [class]="'tone-' + (s.tone ?? 'muted')">
                <dt>{{ s.label }}</dt>
                <dd>{{ s.value }}</dd>
              </div>
            }
          </dl>
        }

        @if (issues().length > 0) {
          <h2>{{ t('module.issues') }}</h2>
          <app-issue-list [cards]="issues()" [cluster]="cluster" (changed)="changed.set(true)" />
        }

        @if (module.workloads.items.length > 0) {
          <h2>{{ t('module.workloads') }} <span class="count">{{ t('module.podsReady', { ready: module.workloads.ready, total: module.workloads.total }) }}</span></h2>
          <ul class="workloads">
            @for (w of module.workloads.items; track w.kind + w.namespace + w.name) {
              <li>
                <span class="wname">{{ w.name }}</span>
                <span class="muted">{{ w.kind }}, {{ w.namespace }}</span>
                <span [class]="'pill ' + (w.ready >= w.desired ? 'tone-ok' : w.ready === 0 ? 'tone-critical' : 'tone-warning')">{{ w.ready }}/{{ w.desired }}</span>
              </li>
            }
          </ul>
        }
      </ion-content>
    </ng-container>
  `,
  styles: `
    header {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-bottom: 1rem;
    }
    .icon {
      flex: none;
      width: 3.25rem;
      height: 3.25rem;
      border-radius: 16px;
      display: grid;
      place-items: center;
      background: var(--tone-soft);
      color: var(--tone);
      font-size: 1.6rem;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
    }
    header p {
      margin: 0.2rem 0 0;
    }
    .summary {
      font-size: 1rem;
      line-height: 1.5;
      margin: 0 0 1.25rem;
    }
    .error {
      color: var(--crit);
      font-size: 0.875rem;
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }
    .links a {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 0.85rem;
      border-radius: 999px;
      background: var(--raise);
      text-decoration: none;
      font-weight: 600;
      font-size: 0.875rem;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 11rem), 1fr));
      gap: 2px;
      margin: 0 0 1.5rem;
      border-radius: var(--radius-m);
      overflow: hidden;
    }
    .stats div {
      background: var(--raise);
      padding: 0.7rem 0.85rem;
    }
    .stats dt {
      color: var(--mute);
      font-size: 0.8125rem;
    }
    .stats dd {
      margin: 0.15rem 0 0;
      font-weight: 650;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .stats .tone-warning dd,
    .stats .tone-critical dd {
      color: var(--tone);
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 650;
      margin: 1.5rem 0 0.6rem;
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .count {
      color: var(--mute);
      font-family: var(--font-body);
      font-size: 0.875rem;
      font-weight: 500;
    }
    .workloads {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .workloads li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0 0.75rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid var(--line);
    }
    .wname {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .workloads .muted {
      grid-row: 2;
      font-size: 0.8125rem;
    }
    .workloads .pill {
      grid-row: 1 / span 2;
      grid-column: 2;
      align-self: center;
    }
  `,
})
export class ModuleSheet implements OnInit {
  // Plain fields: set through ModalController's componentProps.
  module!: ModuleView;
  cluster!: ClusterConfig;
  issueCards: IssueCard[] = [];

  private readonly modals = inject(ModalController);
  private readonly language = inject(LanguageService);
  readonly issues = signal<IssueCard[]>([]);
  readonly changed = signal(false);
  tone = STATUS_TONE.ok;
  statusLabel = '';

  ngOnInit(): void {
    const row = moduleRow(this.module, this.language.translator());
    this.tone = row.tone;
    this.statusLabel = row.statusLabel;
    this.issues.set(this.issueCards);
  }

  close(): Promise<boolean> {
    return this.modals.dismiss({ changed: this.changed() });
  }
}
