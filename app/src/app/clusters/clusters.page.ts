import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { buildClusterView } from '../cluster/cluster-view';
import { ClusterStore } from '../core/cluster-store.service';
import { StatusStore } from '../core/status-store.service';
import { LangChoice, LanguageService } from '../i18n/language.service';
import { Heartbeat } from '../ui/heartbeat';

export const INSTALL_COMMAND = 'helm install kubernanny oci://ghcr.io/kubernanny/charts/kubernanny -n kubernanny --create-namespace';
export const PAIR_COMMAND = 'kubectl -n kubernanny logs deploy/kubernanny';

@Component({
  selector: 'app-clusters',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, RouterLink, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon, IonContent, Heartbeat],
  template: `
    <ng-container *transloco="let t">
      <ion-header class="ion-no-border">
        <ion-toolbar>
          <ion-title>{{ t('clusters.title') }}</ion-title>
          <ion-buttons slot="end">
            <ion-button routerLink="/cluster/new" [attr.aria-label]="t('clusters.add')">
              <ion-icon slot="icon-only" name="add-outline" />
            </ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <div class="wrap">
          @if (onlyDemo()) {
            <aside class="demo-banner">
              <div>
                <strong>{{ t('clusters.demo.title') }}</strong>
                <span class="muted">{{ t('clusters.demo.text') }}</span>
              </div>
              <div class="demo-actions">
                <ion-button size="small" routerLink="/cluster/new">{{ t('clusters.demo.connect') }}</ion-button>
                <ion-button size="small" fill="clear" (click)="endDemo()">{{ t('clusters.demo.end') }}</ion-button>
              </div>
            </aside>
          }
          @if (cards().length > 0) {
            <ul class="cards">
              @for (c of cards(); track c.id) {
                <li>
                  <a [routerLink]="['/c', c.id]" [class]="'tone-' + c.view.tone">
                    <div class="top">
                      <h2 class="display">
                        {{ c.name }}
                        @if (c.demo) {
                          <span class="pill">{{ t('common.demo') }}</span>
                        }
                      </h2>
                      <span class="muted">{{ c.view.subline }}</span>
                    </div>
                    <app-heartbeat [light]="c.view.light" [label]="c.view.headline" />
                    <div class="bottom">
                      <strong>{{ c.view.headline }}</strong>
                      <span class="muted">{{ c.view.checked }}</span>
                    </div>
                  </a>
                </li>
              }
            </ul>
          } @else {
            <section class="empty">
              <h1 class="display">{{ t('clusters.empty.title') }}</h1>
              <p class="lead">{{ t('clusters.empty.lead') }}</p>

              @if (thisAgent()) {
                <div class="local">
                  <p>{{ t('clusters.empty.local') }}</p>
                  <ion-button routerLink="/pair" [queryParams]="{ url: origin }">{{ t('clusters.empty.connectLocal') }}</ion-button>
                </div>
              }

              <ol class="steps">
                <li>
                  <strong>{{ t('clusters.empty.installTitle') }}</strong>
                  <button type="button" class="cmd" (click)="copy(install)"><code>{{ install }}</code><ion-icon name="copy-outline" [attr.aria-label]="t('common.copy')" /></button>
                  <span class="muted" [innerHTML]="t('clusters.empty.installNote')"></span>
                </li>
                <li>
                  <strong>{{ t('clusters.empty.logsTitle') }}</strong>
                  <button type="button" class="cmd" (click)="copy(pair)"><code>{{ pair }}</code><ion-icon name="copy-outline" [attr.aria-label]="t('common.copy')" /></button>
                  <span class="muted">{{ t('clusters.empty.logsNote') }}</span>
                </li>
                <li>
                  <strong>{{ t('clusters.empty.scanTitle') }}</strong>
                  <span class="muted">{{ t('clusters.empty.scanNote') }}</span>
                </li>
              </ol>
              <div class="empty-actions">
                <ion-button fill="outline" routerLink="/cluster/new">{{ t('clusters.empty.manual') }}</ion-button>
                <ion-button fill="clear" (click)="startDemo()">{{ t('clusters.empty.tryDemo') }}</ion-button>
              </div>
            </section>
          }

          <footer class="language">
            <span id="language-label">{{ t('language.label') }}</span>
            <div class="choices" role="group" aria-labelledby="language-label">
              @for (option of languageOptions(); track option.choice) {
                <button type="button" [class.on]="option.on" [attr.aria-pressed]="option.on" [attr.lang]="option.lang" [title]="option.title" (click)="chooseLanguage(option.choice)">
                  {{ option.label }}
                </button>
              }
            </div>
          </footer>
        </div>
      </ion-content>
    </ng-container>
  `,
  styles: `
    ion-toolbar {
      --background: var(--ground);
    }
    ion-title {
      font-family: var(--font-display);
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
    }
    .cards {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
      gap: 1rem;
    }
    a {
      display: block;
      padding: 1.25rem;
      background: var(--surface);
      border-radius: var(--radius-l);
      color: var(--ink);
      text-decoration: none;
      --heartbeat-height: 56px;
    }
    a:hover {
      outline: 1px solid var(--line);
    }
    .top h2 {
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      overflow-wrap: anywhere;
    }
    .top .muted {
      font-size: 0.875rem;
    }
    app-heartbeat {
      margin: 0.75rem -0.5rem;
    }
    .bottom {
      display: grid;
      gap: 0.15rem;
    }
    .bottom strong {
      color: var(--tone);
      font-size: 1.05rem;
    }
    .bottom .muted {
      font-size: 0.8125rem;
    }
    .empty {
      max-width: 40rem;
      margin: 6vh auto 0;
    }
    .empty h1 {
      font-size: clamp(2rem, 8vw, 3rem);
      font-weight: 750;
      letter-spacing: -0.03em;
      line-height: 1.05;
    }
    .lead {
      font-size: 1.0625rem;
      line-height: 1.55;
      color: var(--ink-2);
      margin: 1rem 0 2rem;
    }
    .local {
      background: var(--surface);
      border-radius: var(--radius-l);
      padding: 1rem 1.1rem;
      margin-bottom: 2rem;
    }
    .local p {
      margin: 0 0 0.5rem;
    }
    .steps {
      margin: 0 0 1.5rem;
      padding: 0 0 0 1.4rem;
      display: grid;
      gap: 1.4rem;
    }
    .steps li {
      padding-left: 0.4rem;
    }
    .steps li::marker {
      font-family: var(--font-display);
      font-weight: 700;
      color: var(--accent);
    }
    .steps strong {
      display: block;
      font-size: 1.05rem;
      margin-bottom: 0.4rem;
    }
    .steps .muted code {
      white-space: nowrap;
    }
    .steps .muted {
      display: block;
      font-size: 0.9rem;
      line-height: 1.5;
      margin-top: 0.4rem;
    }
    .cmd {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-s);
      padding: 0.6rem 0.75rem;
      color: var(--ink);
      text-align: left;
      cursor: pointer;
    }
    .cmd code {
      flex: 1;
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
    .cmd ion-icon {
      color: var(--accent);
      flex: none;
    }
    .demo-banner {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem 1rem;
      margin-bottom: 1.25rem;
      padding: 0.9rem 1rem;
      border-radius: var(--radius-m);
      background: color-mix(in srgb, var(--accent) 14%, var(--surface));
    }
    .demo-banner div:first-child {
      display: grid;
      gap: 0.2rem;
      max-width: 34rem;
    }
    .demo-actions,
    .empty-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .language {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 0.5rem 0.75rem;
      margin: 3rem 0 1rem;
      color: var(--mute);
      font-size: 0.8125rem;
    }
    .choices {
      display: inline-flex;
      background: var(--surface);
      border-radius: 999px;
      padding: 3px;
    }
    .choices button {
      border: 0;
      background: transparent;
      color: var(--mute);
      font: inherit;
      font-weight: 600;
      padding: 0.3rem 0.75rem;
      border-radius: 999px;
      cursor: pointer;
    }
    .choices button.on {
      background: var(--raise);
      color: var(--ink);
    }
    .pill {
      vertical-align: middle;
      margin-left: 0.4rem;
      font-size: 0.75rem;
      font-family: var(--font-text, inherit);
      font-weight: 650;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      color: var(--accent);
    }
  `,
})
export class ClustersPage implements OnInit {
  private readonly clusters = inject(ClusterStore);
  private readonly status = inject(StatusStore);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);
  private readonly now = signal(new Date());
  readonly install = INSTALL_COMMAND;
  readonly pair = PAIR_COMMAND;
  readonly origin = location.origin;
  /** True when this page itself is served by a Kubernanny agent. */
  readonly thisAgent = signal(false);

  readonly cards = computed(() =>
    this.clusters.clusters().map((c) => {
      const state = this.status.states()[c.id];
      return { id: c.id, name: c.name, demo: c.demo !== undefined, view: buildClusterView(state?.snapshot ?? null, state?.error ?? null, this.now(), this.language.translator()) };
    }),
  );
  /** Auto, Deutsch, English: the language names stay in their own language, so anyone finds theirs. */
  readonly languageOptions = computed(() => {
    const choice = this.language.choice();
    const tr = this.language.translator();
    const options: { choice: LangChoice; label: string; lang: string | null; title: string }[] = [
      { choice: 'auto', label: tr.t('language.auto'), lang: null, title: tr.t('language.autoTitle') },
      { choice: 'de', label: 'Deutsch', lang: 'de', title: 'Deutsch' },
      { choice: 'en', label: 'English', lang: 'en', title: 'English' },
    ];
    return options.map((o) => ({ ...o, on: o.choice === choice }));
  });
  /** Only demo clusters so far: show how to leave the demo. */
  readonly onlyDemo = computed(() => {
    const list = this.clusters.clusters();
    return list.length > 0 && list.every((c) => c.demo);
  });

  constructor() {
    const tick = setInterval(() => this.now.set(new Date()), 20_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  async ngOnInit(): Promise<void> {
    // demo.kubernanny.app is static hosting: no agent to ask.
    if (location.protocol.startsWith('http') && !location.hostname.startsWith('demo.')) {
      try {
        const res = await fetch('/healthz', { signal: AbortSignal.timeout(3000) });
        this.thisAgent.set(res.ok && ((await res.json()) as { ok?: boolean }).ok === true);
      } catch {
        this.thisAgent.set(false);
      }
    }
  }

  ionViewWillEnter(): void {
    this.status.start();
  }

  ionViewDidLeave(): void {
    this.status.stop();
  }

  async startDemo(): Promise<void> {
    await this.clusters.addDemo();
    void this.status.refreshAll();
  }

  async endDemo(): Promise<void> {
    for (const c of this.clusters.clusters().filter((x) => x.demo)) {
      this.status.forget(c.id);
    }
    await this.clusters.removeDemo();
  }

  chooseLanguage(choice: LangChoice): void {
    void this.language.choose(choice);
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      const toast = await this.toasts.create({ message: this.language.translator().t('common.copied'), duration: 1500, position: 'bottom' });
      await toast.present();
    } catch {
      // Clipboard not allowed (insecure origin): the text is selectable anyway.
    }
  }
}
