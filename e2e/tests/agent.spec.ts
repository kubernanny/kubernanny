import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectToast, openTab, visiblePage, watchErrors } from './helpers';

const AGENT = 'http://127.0.0.1:4320';

/** A real agent (demo cluster inside) serving its own web UI; every call below goes through the end-to-end channel. */
test.describe('agent web UI', () => {
  test.beforeEach(async ({ page }) => {
    const { publicKey } = (await (await page.request.get(`${AGENT}/api/identity`)).json()) as { publicKey: string };
    // A demo agent takes any code; the key is its real one, pinned like from the QR code.
    await page.goto(`${AGENT}/#/pair?code=E2ETEST000&name=homelab&key=${publicKey}`);
    // A link never pairs by itself: the page shows what it would pair with, and waits for the tap.
    await expect(visiblePage(page).getByRole('heading', { name: 'Mit diesem Agent koppeln?' })).toBeVisible();
    await visiblePage(page).locator('ion-button', { hasText: 'Koppeln' }).click();
    await page.waitForURL(/#\/c\//);
  });

  test('shows the agent key from the log before pairing, and refuses a link with another key for the same cluster', async ({ page }) => {
    const { fingerprint } = (await (await page.request.get(`${AGENT}/api/identity`)).json()) as { fingerprint: string };
    const cluster = page.url();
    // Someone else's link for the cluster already in the app: their key, their relay.
    const forged = randomBytes(32).toString('base64url');
    await page.goto(`${AGENT}/#/pair?code=E2ETEST001&name=homelab&key=${forged}&relay=${encodeURIComponent('https://relay.evil.example')}`);
    const warning = visiblePage(page);
    await expect(warning.getByRole('heading', { name: 'Der Schlüssel des Agents hat sich geändert' })).toBeVisible();
    await expect(warning).toContainText(fingerprint);
    await warning.locator('ion-button', { hasText: 'Abbrechen' }).click();
    await page.waitForURL(/#\/clusters/);
    // The cluster still talks to the real agent with its pinned key.
    await page.goto(cluster);
    await expect(visiblePage(page).getByText('Braucht dich')).toBeVisible();
    await visiblePage(page).locator('ion-button:has(ion-icon[name="settings-outline"])').click();
    await expect(visiblePage(page).locator('dd code')).toHaveText(fingerprint);
  });

  test('pairs, shows the cluster and refuses the plain API', async ({ page }) => {
    const errors = watchErrors(page);
    await expect(visiblePage(page).getByRole('heading', { name: 'homelab' })).toBeVisible();
    await expect(visiblePage(page).getByText('Braucht dich')).toBeVisible();
    const plain = await page.request.get(`${AGENT}/api/status`);
    expect(plain.status()).toBe(401);
    expect(errors).toEqual([]);
  });

  test('reads the logs of a crashed pod', async ({ page }) => {
    const cluster = visiblePage(page);
    await cluster.locator('app-issue-list button', { hasText: 'Logs' }).first().click();
    await expect(page.locator('ion-modal')).toContainText(/ERROR|FATAL|error/);
  });

  test('restarts a broken workload through the agent', async ({ page }) => {
    const cluster = visiblePage(page);
    await cluster.locator('app-issue-list button', { hasText: 'neu starten' }).first().click();
    await page.locator('ion-alert button', { hasText: 'neu starten' }).click();
    await expectToast(page, /wird neu gestartet/);
  });

  test('reads the incident history and the backups from the agent', async ({ page }) => {
    const cluster = visiblePage(page);
    await expect(cluster.locator('app-history-section .strip li')).toHaveCount(7);
    await openTab(page, 'Backups');
    await expect(cluster.locator('app-backups-tab')).toContainText('CloudNativePG');
  });

  test('shows the nodes and the settings with the pinned key', async ({ page }) => {
    await openTab(page, 'Nodes');
    await expect(visiblePage(page).locator('app-nodes-tab')).toContainText('rke2-node-1');
    // Ionic moves aria-label into its shadow button, so the icon names the button here.
    await visiblePage(page).locator('ion-button:has(ion-icon[name="settings-outline"])').click();
    const settings = visiblePage(page);
    await expect(settings.getByText('Schlüssel des Agents')).toBeVisible();
    await expect(settings.locator('dd code')).toHaveText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    await expect(settings.getByText('Weiteres Gerät koppeln')).toBeVisible();
  });
});
