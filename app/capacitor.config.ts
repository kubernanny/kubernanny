import type { CapacitorConfig } from '@capacitor/cli';

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
  },
};

export default config;
