import { defineConfig, devices } from '@playwright/test';

/**
 * Two servers, both started from the builds (`npm run build` first):
 * - the app's static build, the full app without an agent behind it (port 4310);
 * - the demo host build (`npm run build:demo`), as demo.kubernanny.app serves it (port 4330);
 * - a real agent in demo mode serving its web UI (port 4320), paired like a
 *   phone would pair, everything over the end-to-end channel.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  // The app follows the browser language; the tests read German unless a test sets another locale.
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], locale: 'de-DE' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 }, locale: 'de-DE' } },
  ],
  webServer: [
    {
      command: 'python3 -m http.server 4310 --bind 127.0.0.1 -d ../app/dist/app/browser',
      url: 'http://127.0.0.1:4310/index.html',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'python3 -m http.server 4330 --bind 127.0.0.1 -d ../app/dist/demo/browser',
      url: 'http://127.0.0.1:4330/index.html',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node dist/main.js',
      cwd: '../agent',
      url: 'http://127.0.0.1:4320/healthz',
      reuseExistingServer: !process.env.CI,
      env: {
        DEMO: 'broken',
        CLUSTER_NAME: 'homelab',
        PORT: '4320',
        METRICS_PORT: '0',
        WEB_ROOT: '../app/dist/app/browser',
        PUBLIC_URL: 'http://127.0.0.1:4320',
        INTERNAL_SOCKET: '/tmp/kubernanny-e2e.sock',
        PAIRING_LOG: 'false',
      },
    },
  ],
});
