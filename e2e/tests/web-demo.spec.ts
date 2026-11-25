import { expect, test } from '@playwright/test';
import { expectToast, openTab, visiblePage, watchErrors } from './helpers';

const DEMO = 'http://127.0.0.1:4310';

test.describe('web demo (no agent, nothing leaves the browser)', () => {
  test('starts from the empty state and shows one cluster per light', async ({ page }) => {
    const errors = watchErrors(page, [/healthz/, /404/]);
    await page.goto(`${DEMO}/#/clusters`);
    await expect(page.getByText('Dein Cluster, auf einen Blick.')).toBeVisible();
    await page.getByText('Erst mal die Demo ansehen').click();
    for (const [name, headline] of [
      ['homelab', /Ausfälle/],
      ['office', /Warnung/],
      ['staging', /Alles läuft/],
    ] as const) {
      const card = page.locator('app-clusters a', { hasText: name }).first();
      await expect(card).toBeVisible();
      await expect(card).toContainText(headline);
      await expect(card.locator('.pill')).toHaveText('Demo');
    }
    await expect(page.getByText('Das ist die Demo.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('opens a cluster, walks every tab, and fixes a problem', async ({ page }) => {
    const errors = watchErrors(page, [/healthz/, /404/]);
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'homelab' }).first().click();
    const cluster = visiblePage(page);
    await expect(cluster.getByRole('heading', { name: 'homelab' })).toBeVisible();
    await expect(cluster.getByText('Braucht dich')).toBeVisible();

    for (const [tab, marker] of [
      ['Dienste', 'app-services-tab'],
      ['Nodes', 'app-nodes-tab'],
      ['Workloads', 'app-workloads-tab'],
      ['Speicher', 'app-storage-tab'],
      ['Backups', 'app-backups-tab'],
      ['Netzwerk', 'app-network-tab'],
      ['Ereignisse', 'app-events-tab'],
      ['Lage', 'app-overview-tab'],
    ] as const) {
      await openTab(page, tab);
      await expect(cluster.locator(marker)).toBeVisible();
    }

    const restart = cluster.locator('app-issue-list button', { hasText: 'neu starten' }).first();
    const title = await restart.locator('xpath=ancestor::li').locator('.title').innerText();
    await restart.click();
    await page.locator('ion-alert button', { hasText: 'neu starten' }).click();
    await expectToast(page, /Demo: .* ist behoben/);
    await expect(cluster.locator('app-issue-list .title', { hasText: title })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('silences an issue and lets it speak again', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'office' }).first().click();
    const cluster = visiblePage(page);
    const first = cluster.locator('app-issue-list li').first();
    const title = await first.locator('.title').innerText();
    await first.locator('button', { hasText: 'Stumm' }).click();
    await page.locator('ion-action-sheet button', { hasText: '8 Stunden' }).click();
    await expectToast(page, 'Stummgeschaltet.');
    const silenced = cluster.locator('section.hints', { hasText: 'Stummgeschaltet' });
    await expect(silenced.locator('.title', { hasText: title })).toBeVisible();
    await expect(silenced).toContainText(/stumm bis/);
    await silenced.locator('button', { hasText: 'Wieder melden' }).first().click();
    await expect(cluster.locator('section.hints', { hasText: 'Stummgeschaltet' })).toHaveCount(0);
  });

  test('switches a component off in the settings', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.goto(`${DEMO}/#/cluster/demo-broken/modules`);
    const settings = visiblePage(page);
    const argo = settings.locator('li', { hasText: 'Argo CD' }).first();
    await expect(argo.locator('ion-toggle')).toHaveJSProperty('checked', true);
    await argo.locator('ion-toggle').click();
    await expect(argo.locator('ion-toggle')).toHaveJSProperty('checked', false);
    await page.goto(`${DEMO}/#/c/demo-broken`);
    await openTab(page, 'Dienste');
    // "Argo CD Image Updater" stays: only the Argo CD integration itself was switched off.
    await expect(visiblePage(page).locator('app-services-tab').getByText('Argo CD', { exact: true })).toHaveCount(0);
    await expect(visiblePage(page).locator('app-services-tab').getByText('Longhorn', { exact: true })).toBeVisible();
  });

  test('shows the last seven days on the overview, and all of them on request', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'homelab' }).first().click();
    const history = visiblePage(page).locator('app-history-section');
    await expect(history.getByRole('heading', { name: 'Letzte 7 Tage' })).toBeVisible();
    await expect(history.locator('.strip li')).toHaveCount(7);
    await expect(history.locator('.strip li').last()).toHaveAttribute('title', /^Heute: \d+ Probleme?$/);
    await expect(history.locator('.strip li.tone-critical').first()).toBeVisible();
    const before = await history.locator('ul li').count();
    await history.getByRole('button', { name: /^Alle \d+ zeigen/ }).click();
    await expect.poll(() => history.locator('ul li').count()).toBeGreaterThan(before);
    await expect(history).toContainText('noch offen, seit');
    await expect(history).toContainText('Gestern');
    await expect(history.locator('.silenced').first()).toContainText('stummgeschaltet');
  });

  test('lists the backups by tool, with what needs attention and what has none', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'homelab' }).first().click();
    await openTab(page, 'Backups');
    const tab = visiblePage(page).locator('app-backups-tab');
    await expect(tab.locator('.summary')).toHaveText(/^3 von 9 brauchen Aufmerksamkeit\.$/);
    await expect(tab.getByRole('heading', { name: /CloudNativePG/ })).toBeVisible();
    await expect(tab.getByRole('heading', { name: /Velero/ })).toBeVisible();
    await expect(tab.locator('li.tone-warning', { hasText: 'shop-api-pg' })).toContainText(/zuletzt vor \d+ h/);
    await expect(tab.locator('li', { hasText: 'shop-api-pg' }).first()).toContainText('S3, s3://shop-backups/cnpg/shop-api-pg');
    await expect(tab.getByRole('heading', { name: /Ohne Backup/ })).toBeVisible();
    await expect(tab).toContainText('monitoring/data-loki-0');
    await expect(tab).toContainText('erreichbar');
  });

  test('groups repeated Kubernetes warnings', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'homelab' }).first().click();
    await openTab(page, 'Ereignisse');
    await expect(visiblePage(page).locator('app-events-tab .pill').first()).toHaveText(/^\d+× (seit \d+ (min|h))?$/);
  });

  test('copies the state as plain text where the browser cannot share', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'office' }).first().click();
    await expect(visiblePage(page).getByText('Braucht dich')).toBeVisible();
    await visiblePage(page).locator('ion-button.share').click();
    await expectToast(page, 'Zustand in die Zwischenablage kopiert.');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split('\n')[0]).toBe('Kubernanny: Zustand von office');
    expect(text).toMatch(/Zustand: 2 Warnungen \(Ampel gelb, \d+ von 100\)/);
    expect(text).toContain('Offene Probleme (2):');
    expect(text).not.toMatch(/demo:\/\/|cnpg\/default/);
  });

  test('starts a maintenance window in the settings and shows it on the overview', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.goto(`${DEMO}/#/cluster/demo-healthy`);
    const settings = visiblePage(page);
    await settings.getByRole('button', { name: 'Wartungsfenster starten' }).click();
    await page.locator('ion-action-sheet button', { hasText: '2 Stunden' }).click();
    await expectToast(page, /^Wartungsfenster bis /);
    await expect(settings.locator('.maintenance-active .pill')).toHaveText(/^Aktiv bis (\S+, )?\d{2}:\d{2}$/);
    await page.goto(`${DEMO}/#/c/demo-healthy`);
    await expect(visiblePage(page).locator('app-overview-tab .maintenance')).toHaveText(/^Wartung bis (\S+, )?\d{2}:\d{2}: keine Benachrichtigungen$/);
    await page.goto(`${DEMO}/#/cluster/demo-healthy`);
    await visiblePage(page).getByRole('button', { name: 'Jetzt beenden' }).click();
    await expectToast(page, 'Wartungsfenster beendet.');
    await expect(visiblePage(page).getByRole('button', { name: 'Wartungsfenster starten' })).toBeVisible();
  });

  test('can be left again', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.getByRole('button', { name: 'Demo beenden' }).click();
    await expect(page.getByText('Dein Cluster, auf einen Blick.')).toBeVisible();
  });
});

test.describe('demo host build (demo.kubernanny.app)', () => {
  const DEMO_HOST = 'http://127.0.0.1:4330';

  test('starts with the demo and has no way to pair or add a cluster', async ({ page }) => {
    const errors = watchErrors(page, [/404/]);
    await page.goto(`${DEMO_HOST}/`);
    await expect(page.locator('app-clusters a', { hasText: 'homelab' }).first()).toBeVisible();
    await expect(page.locator('ion-button:has(ion-icon[name="add-outline"])')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eigenen Cluster verbinden' })).toHaveCount(0);
    // A pairing link leads nowhere: the route does not exist in this build.
    await page.goto(`${DEMO_HOST}/#/pair?url=https%3A%2F%2Fevil.example&code=ABCDE23456`);
    await page.waitForURL(/#\/(clusters|c\/)/);
    await page.goto(`${DEMO_HOST}/#/cluster/new`);
    await page.waitForURL(/#\/(clusters|c\/)/);
    expect(errors).toEqual([]);
  });
});

test.describe('web demo in English', () => {
  test.use({ locale: 'en-US' });

  test('follows an English browser, and switches to German and back on the clusters page', async ({ page }) => {
    const errors = watchErrors(page, [/healthz/, /404/]);
    await page.goto(`${DEMO}/#/clusters`);
    await expect(page.getByText('Your cluster at a glance.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByText('Try the demo first').click();
    await expect(page.getByText('This is the demo.')).toBeVisible();
    for (const [name, headline] of [
      ['homelab', /outages?/],
      ['office', /warnings?/],
      ['staging', /All good/],
    ] as const) {
      await expect(page.locator('app-clusters a', { hasText: name }).first()).toContainText(headline);
    }

    await page.locator('app-clusters a', { hasText: 'homelab' }).first().click();
    const cluster = visiblePage(page);
    await expect(cluster.getByText('Needs you')).toBeVisible();
    await openTab(page, 'Services');
    await expect(cluster.locator('app-services-tab')).toContainText('Tap one for details.');
    await openTab(page, 'Backups');
    await expect(cluster.locator('app-backups-tab .summary')).toHaveText(/^\d+ of \d+ need attention\.$/);
    await openTab(page, 'Overview');
    await expect(cluster.locator('app-history-section')).toContainText('Last 7 days');
    await expect(page).toHaveTitle('Cluster · Kubernanny');

    await page.goto(`${DEMO}/#/clusters`);
    await page.getByRole('button', { name: 'Deutsch' }).click();
    await expect(page.getByText('Das ist die Demo.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    // Stored: a reload stays German although the browser is English.
    await page.reload();
    await expect(page.getByText('Das ist die Demo.')).toBeVisible();
    await page.getByRole('button', { name: 'Auto' }).click();
    await expect(page.getByText('This is the demo.')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
