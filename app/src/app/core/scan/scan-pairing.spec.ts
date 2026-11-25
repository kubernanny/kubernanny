import { describe, expect, it } from 'vitest';
import { pairingRoute, scannedPairingRoute } from '../pairing-link';
import { browserCanScan } from './qr-scanner.service';
import { scanStep } from './scan-pairing.service';

const key = 'A'.repeat(43);
const appLink = `kubernanny://pair?url=https%3A%2F%2Fnanny.example&code=ABCDE23456&name=homelab&key=${key}&relay=https%3A%2F%2Frelay.kubernanny.app`;

describe('a scanned QR code', () => {
  it('takes the app link exactly as a link the system opens', () => {
    expect(scannedPairingRoute(appLink)).toEqual(pairingRoute(appLink));
    expect(scannedPairingRoute(`  ${appLink}\n`)).toEqual(pairingRoute(appLink));
    expect(scannedPairingRoute(appLink)).toMatchObject({ url: 'https://nanny.example', code: 'ABCDE23456', name: 'homelab', key });
  });

  it("takes the web UI's link, with the agent's address from before the #", () => {
    expect(scannedPairingRoute(`https://nanny.example/#/pair?code=ABCDE23456&name=homelab&key=${key}`)).toEqual({ url: 'https://nanny.example', code: 'ABCDE23456', name: 'homelab', key });
    expect(scannedPairingRoute(`http://10.0.0.5:8080/kubernanny/#/pair?code=ABCDE23456&key=${key}`)).toEqual({ url: 'http://10.0.0.5:8080/kubernanny', code: 'ABCDE23456', name: undefined, key });
    // A `url` inside the fragment never wins over the address the page lives at.
    expect(scannedPairingRoute(`https://nanny.example/#/pair?url=https%3A%2F%2Fevil.example&code=ABCDE23456&key=${key}`)?.url).toBe('https://nanny.example');
  });

  it('holds the web link to the same rules as the app link', () => {
    expect(scannedPairingRoute(`https://nanny.example/#/pair?code=ABCDE23456&key=short`)).toBeNull();
    expect(scannedPairingRoute(`https://nanny.example/#/pair?name=homelab&key=${key}`)).toBeNull();
    expect(scannedPairingRoute(`https://user:pw@nanny.example/#/pair?code=ABCDE23456&key=${key}`)).toBeNull();
    expect(scannedPairingRoute(`https://nanny.example/?x=1#/pair?code=ABCDE23456&key=${key}`)).toBeNull();
  });

  it('refuses everything else', () => {
    for (const text of ['', 'ABCDE23456', 'https://kubernanny.app', 'https://nanny.example/#/clusters', 'javascript:alert(1)', 'kubernanny://cluster?id=x', 'WIFI:S:home;T:WPA;P:secret;;', `ftp://nanny.example/#/pair?code=ABCDE23456&key=${key}`]) {
      expect(scannedPairingRoute(text)).toBeNull();
    }
  });
});

describe('scanStep', () => {
  it('opens the pairing page for a pairing link and explains everything else', () => {
    expect(scanStep({ kind: 'text', text: appLink })).toEqual({ pair: pairingRoute(appLink) });
    expect(scanStep({ kind: 'text', text: 'https://example.com' })).toEqual({ message: 'pair.scan.notPairing' });
    expect(scanStep({ kind: 'cancelled' })).toBeNull();
    expect(scanStep({ kind: 'denied' })).toEqual({ message: 'pair.scan.denied' });
    expect(scanStep({ kind: 'preparing' })).toEqual({ message: 'pair.scan.preparing' });
    expect(scanStep({ kind: 'failed' })).toEqual({ message: 'pair.scan.failed' });
  });
});

describe('browserCanScan', () => {
  const win = (detector: unknown, camera = true) => ({ BarcodeDetector: detector, navigator: { mediaDevices: camera ? { getUserMedia: () => undefined } : undefined } }) as unknown as Window;

  it('needs BarcodeDetector with QR codes and a camera API', async () => {
    expect(await browserCanScan(win({ getSupportedFormats: async () => ['ean_13', 'qr_code'] }))).toBe(true);
    expect(await browserCanScan(win({ getSupportedFormats: async () => ['ean_13'] }))).toBe(false);
    expect(await browserCanScan(win(undefined))).toBe(false);
    expect(await browserCanScan(win({ getSupportedFormats: async () => ['qr_code'] }, false))).toBe(false);
    expect(await browserCanScan(win({ getSupportedFormats: () => Promise.reject(new Error('no')) }))).toBe(false);
  });
});
