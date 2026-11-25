import { Injectable, inject, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ModalController } from '@ionic/angular/standalone';

/** What one scan came to. Only `text` carries anything; the caller decides whether it is a pairing link. */
export type ScanOutcome = { kind: 'text'; text: string } | { kind: 'cancelled' | 'denied' | 'preparing' | 'failed' };

/**
 * iOS: `@capacitor/barcode-scanner` (Ionic's plugin, a Swift package; ML Kit
 * has none). Declared here with only what we call, so its web fallback and
 * the QR library behind it never reach the bundle.
 */
interface IosScannerPlugin {
  scanBarcode(options: { hint: number; scanInstructions: string; scanButton: boolean; scanText: string; cameraDirection: number; scanOrientation: number; cancelButtonAccessibilityLabel?: string }): Promise<{ ScanResult: string }>;
}
const iosScanner = registerPlugin<IosScannerPlugin>('CapacitorBarcodeScanner');
/** Html5QrcodeSupportedFormats.QR_CODE, BACK camera, ADAPTIVE orientation in that plugin's numbering. */
const IOS_QR = 0;
const IOS_BACK = 1;
const IOS_ADAPTIVE = 3;
/** "OS-PLUG-BARC-0006" (cancelled) and "…0007" (camera access denied). */
const IOS_CANCELLED = /0006$/;
const IOS_DENIED = /0007$/;

/** Android's Google code scanner module (Play services) can take a while to arrive on a fresh device. */
const ANDROID_INSTALL_WAIT_MS = 30_000;

/** Whether this browser can scan QR codes itself (BarcodeDetector with QR support, and a camera API). */
export async function browserCanScan(win: Window = window): Promise<boolean> {
  const detector = (win as unknown as { BarcodeDetector?: { getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (!detector?.getSupportedFormats || !win.navigator.mediaDevices?.getUserMedia) {
    return false;
  }
  try {
    return (await detector.getSupportedFormats()).includes('qr_code');
  } catch {
    return false;
  }
}

/**
 * Scans one QR code with the camera. Frames stay on the device on every
 * platform: Android hands the camera to Google Play services' code scanner
 * (the app itself has no camera permission), iOS runs Apple's camera with
 * on-device decoding, the browser its own BarcodeDetector.
 */
@Injectable({ providedIn: 'root' })
export class QrScanner {
  private readonly modals = inject(ModalController);
  /** False until checked, and on the web without BarcodeDetector: then no scan button is shown. */
  readonly available = signal(false);

  constructor() {
    void this.check().then((ok) => this.available.set(ok));
  }

  private async check(): Promise<boolean> {
    try {
      switch (Capacitor.getPlatform()) {
        case 'ios':
          return true;
        case 'android': {
          const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
          return (await BarcodeScanner.isSupported()).supported;
        }
        default:
          return await browserCanScan();
      }
    } catch {
      return false;
    }
  }

  async scan(labels: { title: string; hint: string; cancel: string }): Promise<ScanOutcome> {
    switch (Capacitor.getPlatform()) {
      case 'ios':
        return this.scanIos(labels);
      case 'android':
        return this.scanAndroid();
      default:
        return this.scanWeb(labels);
    }
  }

  private async scanIos(labels: { hint: string; cancel: string }): Promise<ScanOutcome> {
    try {
      const { ScanResult } = await iosScanner.scanBarcode({
        hint: IOS_QR,
        scanInstructions: labels.hint,
        scanButton: false,
        scanText: ' ',
        cameraDirection: IOS_BACK,
        scanOrientation: IOS_ADAPTIVE,
        cancelButtonAccessibilityLabel: labels.cancel,
      });
      return { kind: 'text', text: ScanResult };
    } catch (err) {
      const code = String((err as { code?: unknown }).code ?? '');
      return { kind: IOS_CANCELLED.test(code) ? 'cancelled' : IOS_DENIED.test(code) ? 'denied' : 'failed' };
    }
  }

  private async scanAndroid(): Promise<ScanOutcome> {
    const { BarcodeScanner, BarcodeFormat, GoogleBarcodeScannerModuleInstallState } = await import('@capacitor-mlkit/barcode-scanning');
    try {
      if (!(await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available) {
        const done = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ANDROID_INSTALL_WAIT_MS);
          void BarcodeScanner.addListener('googleBarcodeScannerModuleInstallProgress', ({ state }) => {
            if (state === GoogleBarcodeScannerModuleInstallState.COMPLETED || state === GoogleBarcodeScannerModuleInstallState.FAILED || state === GoogleBarcodeScannerModuleInstallState.CANCELED) {
              clearTimeout(timer);
              resolve(state === GoogleBarcodeScannerModuleInstallState.COMPLETED);
            }
          });
        });
        await BarcodeScanner.installGoogleBarcodeScannerModule();
        const installed = await done;
        await BarcodeScanner.removeAllListeners();
        if (!installed) {
          return { kind: 'preparing' };
        }
      }
      const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
      const text = barcodes[0]?.rawValue;
      return text ? { kind: 'text', text } : { kind: 'cancelled' };
    } catch (err) {
      return { kind: /cancel/i.test(String((err as Error).message ?? err)) ? 'cancelled' : 'failed' };
    }
  }

  private async scanWeb(labels: { title: string; hint: string; cancel: string }): Promise<ScanOutcome> {
    const { WebQrScanModal } = await import('./web-qr-scan.modal');
    const modal = await this.modals.create({ component: WebQrScanModal, componentProps: labels });
    await modal.present();
    const { data } = await modal.onDidDismiss<ScanOutcome>();
    return data ?? { kind: 'cancelled' };
  }
}
