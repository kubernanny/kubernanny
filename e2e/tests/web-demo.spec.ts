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

  test('offers the logs of a crash loop first and the restart second, and no restart after an OOMKill', async ({
    page,
  }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'homelab' }).first().click();
    const cluster = visiblePage(page);
    const card = (title: string) =>
      cluster
        .locator('app-issue-list li')
        .filter({ has: page.locator('.title', { hasText: title }) })
        .first();
    const crash = card('default/social-importer: CrashLoopBackOff');
    await expect(crash.locator('.actions button.primary')).toHaveText(/Logs vor dem Absturz/);
    await expect(crash.locator('.second button.secondary')).toHaveText(/social-importer neu starten/);
    await expect(crash.locator('.second .hint')).toContainText('Hilft, wenn du die Ursache schon behoben hast');
    const oom = card('default/shop-mcp-chart: OOMKilled');
    await expect(oom).toContainText('erhöhe das Memory-Limit');
    await expect(oom.locator('button', { hasText: 'neu starten' })).toHaveCount(0);
    // A ConfigMap of the environment changed: the restart is the fix, first and filled.
    await expect(card('default/newsletter-worker').locator('.actions button.primary')).toHaveText(
      /newsletter-worker neu starten/,
    );
    // A forgotten cordon: confirmed with what exactly happens.
    await card('Node rke2-node-4').locator('button', { hasText: 'Wieder freigeben' }).click();
    await expect(page.locator('ion-alert')).toContainText('spec.unschedulable auf false, wie kubectl uncordon');
    await page.locator('ion-alert button', { hasText: 'Abbrechen' }).click();
  });

  test('rolls a manual-sync Argo CD app back from its sheet, simulated', async ({ page }) => {
    const errors = watchErrors(page, [/healthz/, /404/]);
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'homelab' }).first().click();
    const cluster = visiblePage(page);
    await openTab(page, 'Dienste');
    await cluster
      .locator('app-services-tab button')
      .filter({ has: page.locator('strong', { hasText: /^Argo CD$/ }) })
      .first()
      .click();
    const sheet = page.locator('app-module-sheet');
    await expect(sheet.getByRole('heading', { name: 'Zurückrollen' })).toBeVisible();
    const row = sheet.locator('.rollbacks li', { hasText: 'shop-web-app-chart' });
    await expect(row).toContainText('Jetzt ausgerollt: c4d5e6f');
    await row.getByRole('button', { name: 'Zurückrollen' }).click();
    const choices = page.locator('ion-action-sheet button');
    await expect(choices.filter({ hasText: 'a71e0c9' })).toBeVisible();
    await expect(choices.filter({ hasText: '3f9c2a1' })).toBeVisible();
    await expect(choices.filter({ hasText: 'c4d5e6f' })).toHaveCount(0);
    await choices.filter({ hasText: '3f9c2a1' }).click();
    const alert = page.locator('ion-alert');
    await expect(alert).toContainText('shop-web-app-chart geht von c4d5e6f zurück auf 3f9c2a1');
    await expect(alert).toContainText('weicht danach von Git ab');
    await alert.locator('button', { hasText: 'Zurückrollen' }).click();
    await expectToast(page, /Demo: shop-web-app-chart würde jetzt auf 3f9c2a1 zurückgehen/);
    await expect(row).toContainText('Jetzt ausgerollt: 3f9c2a1');
    expect(errors).toEqual([]);
  });

  test('silences an issue and lets it speak again', async ({ page }) => {
    await page.goto(`${DEMO}/#/demo`);
    await page.locator('app-clusters a', { hasText: 'office' }).first().click();
    const cluster = visiblePage(page);
    const first = cluster.locator('app-issue-list li').first();
    const title = await first.locator('.title').innerText();
    await first.getByRole('button', { name: 'Stumm' }).click();
    await page.locator('ion-action-sheet button', { hasText: '8 Stunden' }).click();
    await expectToast(page, 'Stummgeschaltet.');
    // Silenced issues are folded on the overview; one tap shows them.
    await cluster.getByRole('button', { name: /stummgeschaltete zeigen/ }).click();
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
    await expect(tab.locator('li', { hasText: 'shop-api-pg' }).first()).toContainText(
      'S3, s3://shop-backups/cnpg/shop-api-pg',
    );
    await expect(tab.getByRole('heading', { name: /Ohne Backup/ })).toBeVisible();
    await expect(tab).toContainText('monitoring/data-loki-0');
    await expect(tab).toContainText('Erreichbar');
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
    // The certificate, the late database backup and the slow etcd link (standard alerts).
    expect(text).toMatch(/Zustand: 3 Warnungen \(Ampel gelb\)/);
    expect(text).toContain('Offene Probleme (3):');
    expect(text).toContain('rke2-node-1 → rke2-node-5');
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
    await expect(visiblePage(page).locator('app-overview-tab .maintenance')).toHaveText(
      /^Wartung bis (\S+, )?\d{2}:\d{2}: keine Benachrichtigungen$/,
    );
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

test.describe('scanning the pairing QR code in the browser', () => {
  /** A browser with BarcodeDetector and a camera, whose camera "sees" window.__qr. */
  async function fakeCamera(page: import('@playwright/test').Page, qr: string | null): Promise<void> {
    await page.addInitScript((value) => {
      const w = window as unknown as Record<string, unknown>;
      w['__qr'] = value;
      if (value === null) {
        delete w['BarcodeDetector'];
        return;
      }
      w['BarcodeDetector'] = class {
        static async getSupportedFormats() {
          return ['qr_code'];
        }
        async detect() {
          return [{ rawValue: w['__qr'] as string }];
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d')!;
        setInterval(() => ctx.fillRect(0, 0, 64, 64), 50);
        return canvas.captureStream(10);
      };
    }, qr);
  }

  test('offers no scanner where the browser cannot read QR codes', async ({ page }) => {
    await fakeCamera(page, null);
    await page.goto(`${DEMO}/#/clusters`);
    await expect(page.getByText('Dein Cluster, auf einen Blick.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'QR-Code scannen' })).toHaveCount(0);
    await expect(page.getByText('Mit der Handykamera, oder den Link öffnen.', { exact: false })).toBeVisible();
  });

  test('opens the pairing page for the web UI link from the log, with the same checks as a link', async ({ page }) => {
    const key = 'pb1Jnr1HGw7SBrdj3BybbMxBD8U3KIkMOog6iubpzgk';
    await fakeCamera(page, `https://nanny.example/#/pair?code=ABCDE23456&name=homelab&key=${key}`);
    await page.goto(`${DEMO}/#/clusters`);
    await page.getByRole('button', { name: 'QR-Code scannen' }).click();
    await expect(page.getByText('Mit diesem Agent koppeln?')).toBeVisible();
    await expect(visiblePage(page)).toContainText('https://nanny.example');
    await expect(visiblePage(page)).toContainText('homelab');
  });

  test('refuses a QR code that is no pairing link, from "Cluster hinzufügen"', async ({ page }) => {
    await fakeCamera(page, 'https://example.com/hello');
    await page.goto(`${DEMO}/#/cluster/new`);
    await page.getByRole('button', { name: 'QR-Code scannen' }).click();
    await expectToast(page, 'Das ist kein Pairing-Code von Kubernanny.');
    await expect(page.getByText('Mit diesem Agent koppeln?')).toHaveCount(0);
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
