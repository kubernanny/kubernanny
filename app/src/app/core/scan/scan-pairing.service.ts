import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';
import { LanguageService } from '../../i18n/language.service';
import { TranslationKey } from '../../i18n/dictionary';
import { PairingLinkParams, scannedPairingRoute } from '../pairing-link';
import { QrScanner, ScanOutcome } from './qr-scanner.service';

/** Where a scan leads: the pairing page, a message, or nowhere (cancelled). */
export type ScanStep = { pair: PairingLinkParams } | { message: TranslationKey } | null;

export function scanStep(outcome: ScanOutcome): ScanStep {
  switch (outcome.kind) {
    case 'text': {
      const pair = scannedPairingRoute(outcome.text);
      return pair ? { pair } : { message: 'pair.scan.notPairing' };
    }
    case 'cancelled':
      return null;
    case 'denied':
      return { message: 'pair.scan.denied' };
    case 'preparing':
      return { message: 'pair.scan.preparing' };
    default:
      return { message: 'pair.scan.failed' };
  }
}

/**
 * "QR-Code scannen": a scanned pairing link lands on the same /pair page as a
 * link the system opens, with the same checks (pairingRoute) and the same
 * confirmation before anything connects.
 */
@Injectable({ providedIn: 'root' })
export class ScanPairing {
  private readonly scanner = inject(QrScanner);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);
  readonly available = this.scanner.available;

  async start(): Promise<void> {
    const tr = this.language.translator();
    const outcome = await this.scanner.scan({ title: tr.t('pair.scan.title'), hint: tr.t('pair.scan.hint'), cancel: tr.t('common.cancel') });
    await this.follow(outcome);
  }

  /** Also for a result Android delivers after it restarted the app behind the scanner. */
  async follow(outcome: ScanOutcome): Promise<void> {
    const step = scanStep(outcome);
    if (!step) {
      return;
    }
    if ('pair' in step) {
      await this.router.navigate(['/pair'], { queryParams: step.pair });
      return;
    }
    const toast = await this.toasts.create({ message: this.language.translator().t(step.message), duration: 6000, position: 'bottom' });
    await toast.present();
  }
}
