import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, inject, viewChild } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar, ModalController } from '@ionic/angular/standalone';
import type { ScanOutcome } from './qr-scanner.service';

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

const DETECT_EVERY_MS = 200;

/**
 * The browser's scanner: the back camera in a <video>, BarcodeDetector on
 * its frames, nothing leaves the page. Closes with the first QR code it reads.
 */
@Component({
  selector: 'app-web-qr-scan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ title }}</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="close({ kind: 'cancelled' })">{{ cancel }}</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <div class="frame">
        <video #video playsinline muted></video>
        <span class="corners" aria-hidden="true"></span>
      </div>
      <p class="muted">{{ hint }}</p>
    </ion-content>
  `,
  styles: `
    .frame {
      position: relative;
      max-width: 26rem;
      margin: 1rem auto;
      aspect-ratio: 1;
      border-radius: var(--radius-l);
      overflow: hidden;
      background: #000;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .corners {
      position: absolute;
      inset: 12%;
      border: 3px solid var(--accent);
      border-radius: var(--radius-m);
    }
    p {
      text-align: center;
      line-height: 1.5;
    }
  `,
})
export class WebQrScanModal implements OnInit, OnDestroy {
  // Plain fields: ModalController's componentProps assigns them as properties.
  title = '';
  hint = '';
  cancel = '';

  private readonly modals = inject(ModalController);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  async ngOnInit(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (err) {
      const name = (err as DOMException).name;
      await this.close({ kind: name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed' });
      return;
    }
    if (this.closed) {
      this.stop();
      return;
    }
    const video = this.video().nativeElement;
    video.srcObject = this.stream;
    await video.play().catch(() => undefined);
    const Ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = new Ctor({ formats: ['qr_code'] });
    const tick = async () => {
      if (this.closed) {
        return;
      }
      try {
        const [code] = video.readyState >= 2 ? await detector.detect(video) : [];
        if (code?.rawValue) {
          await this.close({ kind: 'text', text: code.rawValue });
          return;
        }
      } catch {
        // A frame that could not be read; the next one may.
      }
      this.timer = setTimeout(tick, DETECT_EVERY_MS);
    };
    void tick();
  }

  ngOnDestroy(): void {
    this.closed = true;
    this.stop();
  }

  async close(outcome: ScanOutcome): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stop();
    await this.modals.dismiss(outcome);
  }

  private stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
