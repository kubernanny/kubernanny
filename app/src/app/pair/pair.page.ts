import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonSpinner } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { fingerprint, parsePublicKey } from '@kubernanny/protocol';
import { AgentClient, Pairing, describeError, deviceName } from '../core/agent-client.service';
import { ClusterConfig } from '../core/agent.model';
import { ClusterStore } from '../core/cluster-store.service';
import { PushRegistration } from '../core/push/push-registration.service';
import { relayUrlAllowed } from '../core/relay-route';
import { StatusStore } from '../core/status-store.service';
import { LanguageService } from '../i18n/language.service';
import { PairingCheck, checkPairing } from './pairing-check';

type State = 'checking' | 'confirm' | 'keyChanged' | 'connecting' | 'failed';

/** "ABCD-EFGH-…" for a base64url key, or '' when it is none. */
function keyFingerprint(key: string): string {
  try {
    return key ? fingerprint(parsePublicKey(key)) : '';
  } catch {
    return '';
  }
}

/**
 * Where a pairing link lands: `kubernanny://pair?url&code&name&key[&relay]` in
 * the native app, `<agent>/#/pair?code&name&key` in the web UI the agent serves
 * (then the agent's own address is the URL).
 *
 * A link can come from anyone (a website, a QR code, another app), so this
 * page never connects by itself: it shows the name, the address, the relay
 * and the agent key's fingerprint (the one the agent's log prints) and pairs
 * only when the person confirms. An entry already in the app under that
 * address or name with another agent key is refused by default; only an
 * explicit "replace" goes on, and only then is that entry's key replaced
 * (and the old device removed at the old agent, best effort).
 *
 * Without `key=` the key is fetched from the agent, which transportAllowed()
 * permits only over https, localhost or the same origin; for any address but
 * this page's own that happens only after the confirmation.
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
            @case ('checking') {
              <ion-spinner />
              <h1 class="display">{{ t('pair.checking') }}</h1>
            }
            @case ('connecting') {
              <ion-spinner />
              <h1 class="display">{{ t('pair.connecting', { name: vm().title }) }}</h1>
            }
            @case ('confirm') {
              <h1 class="display">{{ t('pair.confirmTitle') }}</h1>
              <p class="lead">{{ t('pair.confirmLead') }}</p>
              <dl class="facts">
                @if (vm().name) {
                  <dt>{{ t('pair.nameLabel') }}</dt>
                  <dd>{{ vm().name }}</dd>
                }
                <dt>{{ t('pair.addressLabel') }}</dt>
                <dd><code>{{ address() }}</code></dd>
                @if (relayUrl()) {
                  <dt>{{ t('pair.relayLabel') }}</dt>
                  <dd><code>{{ relayUrl() }}</code></dd>
                }
                <dt>{{ t('pair.agentKey') }}</dt>
                <dd>
                  @if (vm().fingerprint) {
                    <code class="fingerprint">{{ vm().fingerprint }}</code>
                  } @else {
                    <span class="muted">{{ t('pair.keyLater') }}</span>
                  }
                </dd>
              </dl>
              @if (vm().again) {
                <p class="muted">{{ t('pair.alreadyPaired', { name: vm().again }) }}</p>
              }
              @if (error()) {
                <p class="error">{{ error() }}</p>
              }
              <form (ngSubmit)="connect()">
                @if (!linkCode()) {
                  <p class="muted" [innerHTML]="t('pair.codeHelp')"></p>
                  <input name="code" [ngModel]="codeInput()" (ngModelChange)="codeInput.set($event)" placeholder="ABCDE-23456" [attr.aria-label]="t('pair.codeLabel')" autocomplete="off" autocapitalize="characters" />
                }
                <ion-button type="submit" expand="block">{{ t('pair.confirm') }}</ion-button>
              </form>
              <ion-button fill="clear" expand="block" (click)="cancel()">{{ t('common.cancel') }}</ion-button>
            }
            @case ('keyChanged') {
              <h1 class="display warn">{{ t('pair.keyChangedTitle') }}</h1>
              <p>{{ t('pair.keyChangedText', { name: vm().existingName }) }}</p>
              <dl class="facts">
                <dt>{{ t('pair.addressLabel') }}</dt>
                <dd><code>{{ address() }}</code></dd>
                <dt>{{ t('pair.oldKey') }}</dt>
                <dd><code class="fingerprint">{{ vm().existingFingerprint }}</code></dd>
                <dt>{{ t('pair.newKey') }}</dt>
                <dd><code class="fingerprint">{{ vm().fingerprint }}</code></dd>
              </dl>
              <ion-button expand="block" (click)="cancel()">{{ t('common.cancel') }}</ion-button>
              <ion-button fill="clear" color="danger" expand="block" (click)="replace()">{{ t('pair.replace') }}</ion-button>
            }
            @case ('failed') {
              <h1 class="display">{{ t('pair.failed') }}</h1>
              <p>{{ error() }}</p>
              <p class="muted">{{ address() }}</p>
              @if (vm().fingerprint) {
                <p class="muted">{{ t('pair.agentKey') }} <code>{{ vm().fingerprint }}</code></p>
              }
              <ion-button (click)="retry()">{{ t('pair.retry') }}</ion-button>
              <ion-button fill="clear" (click)="cancel()">{{ t('common.cancel') }}</ion-button>
            }
          }
        </div>
      </ion-content>
    </ng-container>
  `,
  styles: `
    .box {
      max-width: 28rem;
      margin: 12vh auto 0;
      text-align: center;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin: 1rem 0 0.75rem;
      overflow-wrap: anywhere;
    }
    h1.warn {
      color: var(--crit);
    }
    .lead {
      line-height: 1.5;
    }
    .facts {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.4rem 0.75rem;
      margin: 1.25rem 0;
      text-align: left;
    }
    .facts dt {
      color: var(--mute);
    }
    .facts dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    code {
      font-size: 0.8125rem;
    }
    .fingerprint {
      font-size: 1rem;
      font-weight: 650;
      letter-spacing: 0.04em;
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
  private readonly push = inject(PushRegistration);
  private readonly language = inject(LanguageService);

  readonly state = signal<State>('checking');
  readonly error = signal('');
  readonly codeInput = signal('');
  /** The code came with the link: no input field, only the confirmation. */
  readonly linkCode = signal(false);
  readonly address = signal('');
  readonly relayUrl = signal('');
  private readonly agentKey = signal('');
  private readonly check = signal<PairingCheck>({ kind: 'new' });
  /** Set once the person chose "replace" on the key-changed screen. */
  private readonly replacing = signal(false);
  /** Kept across retries: the code works once, the registered key stays valid. */
  private readonly pairing = signal<Pairing | null>(null);
  /** Bumped by every new link, so an answer for an older one is dropped. */
  private generation = 0;

  readonly vm = computed(() => {
    const check = this.check();
    const existing = check.kind === 'new' ? null : check.existing;
    return {
      name: this.name() ?? '',
      title: this.name() || this.address(),
      fingerprint: keyFingerprint(this.agentKey()),
      again: check.kind === 'again' ? check.existing.name : '',
      existingName: existing?.name ?? '',
      existingFingerprint: existing ? keyFingerprint(existing.agentKey) : '',
    };
  });

  constructor() {
    // An effect, not ngOnInit: a second pairing link while this page is open
    // reuses the component with new query parameters.
    effect(() => {
      const url = this.url();
      const code = this.code();
      const key = this.key();
      const relay = this.relay();
      untracked(() => void this.start(url, code, key, relay));
    });
  }

  private async start(url: string | undefined, code: string | undefined, key: string | undefined, relay: string | undefined): Promise<void> {
    const generation = ++this.generation;
    this.state.set('checking');
    this.error.set('');
    this.pairing.set(null);
    this.replacing.set(false);
    this.check.set({ kind: 'new' });
    this.address.set((url || location.origin).replace(/\/+$/, ''));
    this.codeInput.set(code ?? '');
    this.linkCode.set(!!code);
    this.agentKey.set(key && keyFingerprint(key) ? key : '');
    // Never fetch an unpinned key through a relay: the relay is only for a key the link itself carries.
    this.relayUrl.set(this.agentKey() && relay && relayUrlAllowed(relay) ? relay.replace(/\/+$/, '') : '');
    await this.clusters.loaded;
    try {
      // This page's own agent: asking it for its key reaches nobody new, and the fingerprint can be shown before pairing.
      if (!this.agentKey() && this.address() === location.origin) {
        this.agentKey.set((await this.client.identity(this.address())).publicKey);
      }
    } catch (err) {
      if (generation === this.generation) {
        this.error.set(describeError(err, this.language.translator()));
        this.state.set('failed');
      }
      return;
    }
    if (generation === this.generation) {
      this.decide();
    }
  }

  /** Compares the key with the clusters in the app: confirm, or the key-changed warning. */
  private decide(): void {
    if (!this.agentKey()) {
      // Only known after the confirmation (fetched over TLS); compared again then.
      this.state.set('confirm');
      return;
    }
    const check = checkPairing(this.clusters.clusters(), this.address(), this.name(), this.agentKey());
    this.check.set(check);
    this.state.set(check.kind === 'keyChanged' && !this.replacing() ? 'keyChanged' : 'confirm');
  }

  /** The explicit way past the key-changed warning. */
  replace(): void {
    this.replacing.set(true);
    void this.connect();
  }

  retry(): void {
    if (this.pairing() || this.agentKey()) {
      void this.connect();
    } else {
      void this.start(this.url(), this.code(), this.key(), this.relay());
    }
  }

  cancel(): void {
    void this.router.navigateByUrl('/clusters', { replaceUrl: true });
  }

  /** Runs only from the person's tap on "Pair" (or "Replace", or "Try again" after either). */
  async connect(): Promise<void> {
    this.state.set('connecting');
    this.error.set('');
    try {
      let pairing = this.pairing();
      if (!pairing) {
        if (!this.agentKey()) {
          this.agentKey.set((await this.client.identity(this.address())).publicKey);
          this.decide();
          if (this.state() === 'keyChanged') {
            return;
          }
          this.state.set('connecting');
        }
        if (!this.codeInput().trim()) {
          this.state.set('confirm');
          return;
        }
        pairing = await this.client.pair(this.address(), this.agentKey(), this.codeInput(), deviceName(navigator.userAgent, this.language.translator().t('common.device')), this.relayUrl() || undefined);
        this.pairing.set(pairing);
        this.codeInput.set('');
      }
      const saved = await this.store(pairing);
      void this.status.refresh(saved);
      // The code must not linger in the address bar or the history.
      await this.router.navigate(['/c', saved.id], { replaceUrl: true });
    } catch (err) {
      this.error.set(describeError(err, this.language.translator()));
      this.state.set(this.pairing() ? 'failed' : this.agentKey() || this.linkCode() ? 'confirm' : 'failed');
    }
  }

  /**
   * A new entry, or (confirmed) the existing one with the new keys. The
   * existing entry keeps its id and the person's switches; its push
   * registration and its device at the old agent go, since this device no
   * longer holds that device key.
   */
  private async store(pairing: Pairing): Promise<ClusterConfig> {
    const { cluster, ...connection } = pairing;
    const check = this.check();
    const name = this.name() || cluster;
    if (check.kind === 'new' || (check.kind === 'keyChanged' && !this.replacing())) {
      return this.clusters.save({ ...connection, name });
    }
    const old = check.existing;
    const saved = await this.clusters.save(
      { ...connection, id: old.id, name: this.name() || old.name, ...(old.widgetOff ? { widgetOff: true } : {}), ...(old.relayOff ? { relayOff: true } : {}) },
      { replaceKeys: true },
    );
    this.status.forget(old.id);
    void this.retire(old);
    return saved;
  }

  /** Best effort and in the background: the old agent may be unreachable, or not the real one. */
  private async retire(old: ClusterConfig): Promise<void> {
    await this.push.forget(old).catch(() => undefined);
    await this.client.revokeDevice(old, old.deviceId).catch(() => undefined);
  }
}
