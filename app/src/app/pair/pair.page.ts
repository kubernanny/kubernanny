import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonSpinner } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { fingerprint, parsePublicKey } from '@kubernanny/protocol';
import { AgentClient, Pairing, describeError, deviceName } from '../core/agent-client.service';
import { ClusterStore } from '../core/cluster-store.service';
import { relayUrlAllowed } from '../core/relay-route';
import { StatusStore } from '../core/status-store.service';
import { LanguageService } from '../i18n/language.service';

/**
 * Where a pairing link lands: `kubernanny://pair?url&code&name&key` in the native
 * app, `<agent>/#/pair?code&name&key` in the web UI the agent serves (then the
 * agent's own address is the URL). Creates a key pair for this device,
 * registers it with the one-time code, pins the agent key from the link and
 * opens the cluster. With `relay=` next to `key=` the pairing may go through
 * that relay when the address is out of reach. Without `key=` the key is fetched from the agent, which
 * transportAllowed() permits only over https, localhost or the same origin.
 */
@Component({
  selector: 'app-pair',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, FormsModule, IonContent, IonButton, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      <ion-content class="ion-padding">
        <div class="box">
          @switch (state()) {
            @case ('connecting') {
              <ion-spinner />
              <h1 class="display">{{ t('pair.connecting', { name: name() || address() }) }}</h1>
              @if (keyFingerprint()) {
                <p class="muted">{{ t('pair.agentKey') }} <code>{{ keyFingerprint() }}</code></p>
              }
            }
            @case ('needsCode') {
              @if (error()) {
                <p class="error">{{ error() }}</p>
              }
              <h1 class="display">{{ t('pair.enterCode') }}</h1>
              <p class="muted" [innerHTML]="t('pair.codeHelp')"></p>
              <form (ngSubmit)="connect()">
                <input name="code" [ngModel]="codeInput()" (ngModelChange)="codeInput.set($event)" placeholder="ABCDE-23456" [attr.aria-label]="t('pair.codeLabel')" autocomplete="off" autocapitalize="characters" />
                <ion-button type="submit" expand="block">{{ t('pair.connect') }}</ion-button>
              </form>
            }
            @case ('failed') {
              <h1 class="display">{{ t('pair.failed') }}</h1>
              <p>{{ error() }}</p>
              <p class="muted">{{ address() }}</p>
              @if (keyFingerprint()) {
                <p class="muted">{{ t('pair.agentKey') }} <code>{{ keyFingerprint() }}</code></p>
              }
              <ion-button (click)="connect()">{{ t('pair.retry') }}</ion-button>
              <ion-button fill="clear" (click)="router.navigateByUrl('/clusters')">{{ t('common.cancel') }}</ion-button>
            }
          }
        </div>
      </ion-content>
    </ng-container>
  `,
  styles: `
    .box {
      max-width: 28rem;
      margin: 18vh auto 0;
      text-align: center;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin: 1rem 0 0.75rem;
      overflow-wrap: anywhere;
    }
    code {
      font-size: 0.8125rem;
    }
    .error {
      color: var(--crit);
    }
    input {
      width: 100%;
      margin: 1rem 0;
      padding: 0.8rem 1rem;
      border-radius: var(--radius-m);
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink);
      font: inherit;
    }
  `,
})
export class PairPage {
  readonly url = input<string>();
  readonly code = input<string>();
  readonly name = input<string>();
  /** The agent's public key from the link: pinned without trusting the network. */
  readonly key = input<string>();
  /** The agent's relay from the link (https); used only together with `key` from the same link. */
  readonly relay = input<string>();

  readonly router = inject(Router);
  private readonly client = inject(AgentClient);
  private readonly clusters = inject(ClusterStore);
  private readonly status = inject(StatusStore);
  private readonly language = inject(LanguageService);

  readonly state = signal<'connecting' | 'needsCode' | 'failed'>('connecting');
  readonly error = signal('');
  readonly codeInput = signal('');
  readonly address = signal('');
  private readonly agentKey = signal('');
  private readonly relayUrl = signal('');
  /** Kept across retries: the code works once, the registered key stays valid. */
  private readonly pairing = signal<Pairing | null>(null);
  readonly keyFingerprint = computed(() => {
    try {
      return this.agentKey() ? fingerprint(parsePublicKey(this.agentKey())) : '';
    } catch {
      return '';
    }
  });

  constructor() {
    // An effect, not ngOnInit: a second pairing link while this page is open
    // reuses the component with new query parameters.
    effect(() => {
      const url = this.url();
      const code = this.code();
      const key = this.key();
      const relay = this.relay();
      untracked(() => this.start(url, code, key, relay));
    });
  }

  private start(url: string | undefined, code: string | undefined, key: string | undefined, relay: string | undefined): void {
    this.error.set('');
    this.pairing.set(null);
    this.address.set((url || location.origin).replace(/\/+$/, ''));
    this.codeInput.set(code ?? '');
    this.agentKey.set(key ?? '');
    // Never fetch an unpinned key through a relay: the relay is only for a key the link itself carries.
    this.relayUrl.set(key && relay && relayUrlAllowed(relay) ? relay.replace(/\/+$/, '') : '');
    if (this.codeInput()) {
      void this.connect();
    } else {
      this.state.set('needsCode');
    }
  }

  async connect(): Promise<void> {
    this.state.set('connecting');
    await this.clusters.loaded;
    try {
      let pairing = this.pairing();
      if (!pairing) {
        if (!this.agentKey()) {
          this.agentKey.set((await this.client.identity(this.address())).publicKey);
        }
        pairing = await this.client.pair(this.address(), this.agentKey(), this.codeInput(), deviceName(navigator.userAgent, this.language.translator().t('common.device')), this.relayUrl() || undefined);
        this.pairing.set(pairing);
        this.codeInput.set('');
      }
      const { cluster, ...connection } = pairing;
      const existing = this.clusters.clusters().find((c) => c.url === connection.url);
      const saved = await this.clusters.save({ ...connection, id: existing?.id, name: this.name() || cluster });
      void this.status.refresh(saved);
      // The code must not linger in the address bar or the history.
      await this.router.navigate(['/c', saved.id], { replaceUrl: true });
    } catch (err) {
      this.error.set(describeError(err, this.language.translator()));
      this.state.set(this.pairing() ? 'failed' : 'needsCode');
    }
  }
}
