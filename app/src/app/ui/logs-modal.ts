import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonHeader, IonSpinner, IonTitle, IonToolbar, ModalController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { AgentClient, describeError } from '../core/agent-client.service';
import { ClusterConfig, Logs } from '../core/agent.model';
import { LanguageService } from '../i18n/language.service';
import { Translator } from '../i18n/translator';

interface LogLine {
  time: string;
  text: string;
  level: 'error' | 'warn' | 'plain';
}

/** Splits "2026-…Z message" into time and text, and marks error and warning lines. */
export function parseLog(text: string): LogLine[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      const m = /^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}))\S*\s(.*)$/.exec(line);
      const body = m ? m[3] : line;
      const level = /\b(error|fatal|panic|exception|failed)\b/i.test(body) ? 'error' : /\b(warn|warning)\b/i.test(body) ? 'warn' : 'plain';
      return { time: m ? m[2] : '', text: body, level };
    });
}

const LOG_LINES = 300;

/** "pod-x, Container app, der Lauf vor dem letzten Absturz, letzte 300 Zeilen": where the lines come from. */
export function logSource(logs: Logs, tr: Translator): string {
  return [logs.pod, logs.container ? tr.t('logs.container', { name: logs.container }) : null, logs.previous ? tr.t('logs.previousRun') : null, tr.t('logs.lastLines', { count: LOG_LINES })]
    .filter(Boolean)
    .join(', ');
}

@Component({
  selector: 'app-logs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ t('logs.title') }}</ion-title>
          <ion-buttons slot="end">
            <ion-button (click)="close()">{{ t('common.close') }}</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <h2 class="display">{{ title }}</h2>
        @if (logs()) {
          <p class="muted source">{{ source() }}</p>
          <div class="log" role="log">
            @for (line of lines(); track $index) {
              <div [class]="'line ' + line.level">
                <span class="time">{{ line.time }}</span><span class="text">{{ line.text }}</span>
              </div>
            } @empty {
              <p class="muted">{{ t('logs.empty') }}</p>
            }
          </div>
        } @else if (error(); as e) {
          <p class="error">{{ e }}</p>
        } @else {
          <div class="page-spinner"><ion-spinner /></div>
        }
      </ion-content>
    </ng-container>
  `,
  styles: `
    h2 {
      font-size: 1.25rem;
      overflow-wrap: anywhere;
    }
    .source {
      font-size: 0.875rem;
      margin: 0.4rem 0 1rem;
    }
    .log {
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.75rem 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      line-height: 1.5;
      user-select: text;
    }
    .line {
      display: flex;
      gap: 0.75rem;
      padding: 0 0.9rem;
    }
    .line.error {
      background: var(--crit-soft);
      box-shadow: inset 3px 0 0 var(--crit);
    }
    .line.warn {
      background: var(--warn-soft);
      box-shadow: inset 3px 0 0 var(--warn);
    }
    .time {
      flex: none;
      color: var(--mute);
      min-width: 4.5em;
    }
    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .error {
      color: var(--crit);
    }
  `,
})
export class LogsModal implements OnInit {
  // Plain fields, not input(): ModalController's componentProps assigns them
  // as properties and would replace an input signal with a value.
  cluster!: ClusterConfig;
  issueId!: string;
  index = 0;
  title = '';

  private readonly client = inject(AgentClient);
  private readonly modals = inject(ModalController);
  private readonly language = inject(LanguageService);
  readonly logs = signal<Logs | null>(null);
  readonly lines = signal<LogLine[]>([]);
  readonly error = signal<string | null>(null);
  readonly source = computed(() => {
    const logs = this.logs();
    return logs ? logSource(logs, this.language.translator()) : '';
  });

  async ngOnInit(): Promise<void> {
    try {
      const logs = await this.client.logs(this.cluster, this.issueId, this.index);
      this.lines.set(parseLog(logs.text));
      this.logs.set(logs);
    } catch (err) {
      this.error.set(describeError(err, this.language.translator()));
    }
  }

  close(): Promise<boolean> {
    return this.modals.dismiss();
  }
}
