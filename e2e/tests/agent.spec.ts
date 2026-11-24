import { expect, test } from '@playwright/test';
import { expectToast, openTab, visiblePage, watchErrors } from './helpers';

const AGENT = 'http://127.0.0.1:4320';

/** A real agent (demo cluster inside) serving its own web UI; every call below goes through the end-to-end channel. */
test.describe('agent web UI', () => {
  test.beforeEach(async ({ page }) => {
    const { publicKey } = (await (await page.request.get(`${AGENT}/api/identity`)).json()) as { publicKey: string };
    // A demo agent takes any code; the key is its real one, pinned like from the QR code.
    await page.goto(`${AGENT}/#/pair?code=E2ETEST000&name=homelab&key=${publicKey}`);
    await page.waitForURL(/#\/c\//);
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
