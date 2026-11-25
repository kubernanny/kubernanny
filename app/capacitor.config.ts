import type { CapacitorConfig } from '@capacitor/cli';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One QR scanner plugin per platform (src/app/core/scan/qr-scanner.service.ts):
 * Android uses ML Kit's Google code scanner (`@capacitor-mlkit/barcode-scanning`,
 * no camera permission, the camera runs in Google Play services), iOS uses
 * `@capacitor/barcode-scanner` (ML Kit has no Swift package, the iOS project
 * uses Swift Package Manager). Each is left out of the other platform, so
 * Android carries no second camera stack and iOS no plugin it cannot link.
 * Every other dependency stays included: the allowlist is the package's
 * dependencies minus that one plugin (names that are no plugin are ignored).
 */
const dependencies = Object.keys((JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies);
const without = (plugin: string) => dependencies.filter((name) => name !== plugin);

const config: CapacitorConfig = {
  appId: 'app.kubernanny',
  appName: 'Kubernanny',
  webDir: 'dist/app/browser',
  android: {
    // The WebView's page is https://localhost; agents in a LAN or VPN are often
    // plain http://. Every call to them is end-to-end encrypted with Noise
    // (docs/PROTOCOL.md), so the transport only carries ciphertext. Without
    // this, Android blocks those calls as mixed content. See docs/RELEASING.md.
    allowMixedContent: true,
    includePlugins: without('@capacitor/barcode-scanner'),
  },
  ios: {
    includePlugins: without('@capacitor-mlkit/barcode-scanning'),
  },
};

export default config;
