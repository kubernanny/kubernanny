const { chromium, devices } = require('playwright');

/** The module sheet scrolled to its first list of objects (app-detail-section). */
async function detailShot(page, file) {
  const section = page.locator('app-module-sheet app-detail-section').first();
  if ((await section.count()) === 0) {
    return;
  }
  await page.locator('app-module-sheet ion-content').evaluate(async (el) => {
    const target = el.querySelector('app-detail-section');
    const scroller = await el.getScrollElement();
    await el.scrollToPoint(0, target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 24);
  });
  await page.waitForTimeout(500);
  await shot(page, file);
}

const { BASE, LABELS, scroll, scrollTo, tab, closeSheet, pairAll, openCluster } = require('./helpers.cjs');

const OUT = process.env.OUT ?? 'raw';
const errors = [];

const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

async function context(browser, opts, label) {
  const ctx = await browser.newContext({ locale: 'en-US', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text().slice(0, 200)}`));
  return { ctx, page };
}

const PHONE = devices['iPhone 15'];

async function phoneDark(browser, L) {
  const { ctx, page } = await context(browser, { ...PHONE, colorScheme: 'dark' }, 'phone');
  await page.goto(`${BASE}/#/clusters`);
  await page.waitForTimeout(1800);
  await shot(page, '01-start-empty');
  await scroll(page, 700);
  await shot(page, '02-start-install-steps');
  await page.goto(`${BASE}/#/pair`);
  await page.waitForTimeout(1200);
  await shot(page, '03-pair-code');

  await pairAll(page);
  await shot(page, '04-clusters');

  await openCluster(page, 'homelab');
  await shot(page, '05-overview-red');
  await scroll(page, 1100);
  await shot(page, '06-overview-issues');
  await scrollTo(page, 'app-overview-tab .history, app-history-section');
  await shot(page, '61-history');
  await page.locator('app-history-section button', { hasText: L.showAll }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await scroll(page, 4300);
  await shot(page, '07-overview-charts');
  await scroll(page, 5600);
  await scroll(page, 7400);
  // Use, requests and limits per node, under the cluster's figures.
  const perNode = page.locator('app-overview-tab .per-node').last();
  if ((await perNode.count()) > 0) {
    await perNode.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, '84-overview-per-node');
  } else {
    errors.push('no per-node section for 84-overview-per-node');
  }
  // Manual Argo CD apps with a change waiting: one calm card, and the list behind it.
  const pending = page.locator('app-overview-tab app-pending-sync-card').last();
  if ((await pending.count()) > 0) {
    await pending.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 0));
    await page.waitForTimeout(400);
    await shot(page, '89-overview-ready-to-sync');
    await pending.locator('button').click();
    await page.waitForSelector('app-pending-sync-sheet li', { timeout: 10000 });
    await page.waitForTimeout(900);
    await shot(page, '90-ready-to-sync-list');
    await page.locator('app-pending-sync-sheet ion-button', { hasText: L.close }).click();
    await page.waitForTimeout(700);
  } else {
    errors.push('no ready-to-sync card for 89-overview-ready-to-sync');
  }

  // actions: logs, confirm, toast, silence
  await scroll(page, 900);
  await page.locator('app-issue-list button', { hasText: L.logs }).first().click();
  await page.waitForSelector('app-logs .log', { timeout: 10000 });
  await shot(page, '10-logs');
  await page.locator('app-logs ion-button', { hasText: L.close }).click();
  await page.waitForTimeout(700);
  await page.locator('app-issue-list button', { hasText: L.restart }).first().click();
  await page.waitForSelector('ion-alert', { timeout: 5000 });
  await shot(page, '11-confirm-restart');
  await page.locator('ion-alert button.alert-button-role-confirm').click();
  await page.waitForSelector('ion-toast', { timeout: 5000 });
  await page.waitForTimeout(500);
  await shot(page, '12-action-done');
  await page.waitForTimeout(3500);
  await page.locator('app-issue-list').first().getByRole('button', { name: L.silence }).first().click();
  await page.waitForSelector('ion-action-sheet', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot(page, '63-silence');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  await tab(page, L.services);
  await shot(page, '13-services');
  await scroll(page, 1500);
  await scroll(page, 3200);
  await scroll(page, 0);
  await page.locator('app-services-tab button', { hasText: 'Argo CD' }).first().click();
  await page.waitForTimeout(1100);
  await shot(page, '16-sheet-argocd');
  await page.locator('app-module-sheet ion-content').evaluate((el) => el.scrollToPoint(0, 900));
  await page.waitForTimeout(500);
  await closeSheet(page, L);
  for (const [name, file] of [
    ['Longhorn', '18-sheet-longhorn'],
    ['CloudNativePG', '19-sheet-cnpg'],
    ['Prometheus', '20-sheet-prometheus'],
    ['Grafana', '21-sheet-grafana'],
    ['kured', '22-sheet-kured'],
    ['Known vulnerabilities', '64-sheet-vulnerabilities'],
    ['Security', '65-sheet-security'],
    ['Alertmanager', 'raw-sheet-alertmanager'],
    ['Redis / Valkey', 'raw-sheet-redis'],
    ['Kubernanny', 'raw-sheet-kubernanny'],
  ]) {
    await scroll(page, 0);
    // By the row's own name: another row's summary may mention it (Known vulnerabilities names CloudNativePG).
    const target = page.locator('app-services-tab button', { has: page.locator('.name strong').getByText(name, { exact: true }) }).first();
    if ((await target.count()) === 0) {
      errors.push(`no service "${name}" for ${file}`);
      continue;
    }
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await page.waitForTimeout(1100);
    await shot(page, file);
    const details = { 'raw-sheet-kubernanny': '93-sheet-kubernanny-timing' }[file];
    if (details) {
      await detailShot(page, details);
    }
    await closeSheet(page, L);
  }

  await tab(page, L.nodes);
  await shot(page, '23-nodes');
  await scroll(page, 900);
  await shot(page, '24-nodes-details');
  await scroll(page, 3300);
  await shot(page, '25-nodes-rebooting');

  await tab(page, L.workloads);
  await shot(page, '26-workloads');
  await page.locator('app-workloads-tab .row').first().click();
  await page.waitForTimeout(600);
  await page.locator('app-workloads-tab .filters button', { hasText: L.problems }).click();
  await page.waitForTimeout(600);
  await shot(page, '28-workloads-problems');
  await page.locator('app-workloads-tab .filters button', { hasText: L.all }).click();
  await page.locator('app-workloads-tab input[type=search]').fill('grafana');
  await page.waitForTimeout(600);

  await tab(page, L.storage);
  await shot(page, '30-storage');
  await scroll(page, 900);

  await tab(page, L.backups);
  await shot(page, '66-backups');
  await scroll(page, 1400);

  await tab(page, L.network);
  await shot(page, '32-network');
  await scroll(page, 2400);

  await tab(page, L.events);
  await shot(page, '34-events');

  await page.locator('.ion-page:not(.ion-page-hidden) ion-button:has(ion-icon[name="settings-outline"])').first().click();
  await page.waitForSelector('app-cluster-form', { timeout: 10000 });
  await page.waitForTimeout(1500);
  await shot(page, '35-settings');
  await page.locator('app-cluster-form ion-button', { hasText: L.newCode }).click();
  await page.waitForTimeout(900);
  await scroll(page, 900);
  await shot(page, '36-settings-agent-and-pairing');
  await scroll(page, 1800);
  await shot(page, '59-settings-maintenance');
  await scroll(page, 0);
  await page.locator('app-cluster-form ion-button', { hasText: L.modules }).first().click();
  await page.waitForSelector('app-modules-settings', { timeout: 10000 });
  await page.waitForTimeout(1200);
  await shot(page, '68-modules');
  await scroll(page, 1600);
  await shot(page, '69-modules-actions');

  await openCluster(page, 'office');
  await shot(page, '37-overview-yellow');
  await openCluster(page, 'staging');
  await shot(page, '38-overview-green');
  await scroll(page, 600);
  await ctx.close();
}

async function phoneLight(browser, L) {
  const { ctx, page } = await context(browser, { ...PHONE, colorScheme: 'light' }, 'light');
  await pairAll(page);
  await openCluster(page, 'homelab');
  await shot(page, '41-light-overview');
  await tab(page, L.nodes);
  await ctx.close();
}

/** The built-in demo, as a visitor of demo.kubernanny.app sees it: no agent behind it. */
async function demo(browser) {
  const { ctx, page } = await context(browser, { ...PHONE, colorScheme: 'dark' }, 'demo');
  await page.goto(`${BASE}/#/demo`);
  await page.waitForSelector('app-clusters app-nanny-eye', { timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot(page, '60-demo');
  await ctx.close();
}

async function german(browser, L) {
  const { ctx, page } = await context(browser, { ...PHONE, colorScheme: 'dark', locale: 'de-DE' }, 'german');
  await pairAll(page);
  await openCluster(page, 'homelab');
  await shot(page, '71-de-overview');
  await scroll(page, 1100);
  await tab(page, L.backups);
  await ctx.close();
}

async function tablet(browser, L) {
  const { ctx, page } = await context(browser, { ...devices['iPad Mini'], colorScheme: 'dark' }, 'tablet');
  await pairAll(page);
  await openCluster(page, 'homelab');
  await shot(page, '43-tablet-overview');
  await tab(page, L.storage);
  await ctx.close();
}

async function desktop(browser, L, scheme) {
  const { ctx, page } = await context(browser, { viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, colorScheme: scheme }, `desktop-${scheme}`);
  await pairAll(page);
  const p = scheme === 'dark' ? 'desktop' : 'desktop-light';
  await openCluster(page, 'homelab');
  await shot(page, `${scheme === 'dark' ? 46 : 55}-${p}-overview`);
  if (scheme === 'dark') {
    // The rail at a full-HD width too, and the eye with its countdown ring close up.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(500);
    await shot(page, 'raw-desktop-1920-overview');
    await page.locator('.hero').last().screenshot({ path: `${OUT}/raw-hero-ring.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
    await scroll(page, 2200);
    // A range change on a slow connection: the charts keep their frame and shimmer until the data is there.
    await page.route('**/api/e2e', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue().catch(() => undefined);
    });
    await page.locator('app-overview-tab .range button').last().click();
    await page.waitForTimeout(600);
    await shot(page, 'raw-desktop-charts-loading');
    await page.unroute('**/api/e2e');
    await page.waitForTimeout(3500);
    await tab(page, L.nodes);
    await shot(page, '49-desktop-nodes');
  }
  await ctx.close();
}

/** The phone with the root font at the app's cap (23 px, what Dynamic Type reaches): nothing cut, nothing on top of each other. */
async function largeText(browser, L) {
  const { ctx, page } = await context(browser, { ...PHONE, colorScheme: 'dark' }, 'large text');
  await pairAll(page);
  await page.addStyleTag({ content: 'html { font-size: 23px !important; }' });
  await openCluster(page, 'homelab');
  await page.addStyleTag({ content: 'html { font-size: 23px !important; }' });
  await page.waitForTimeout(500);
  await shot(page, 'raw-phone-23px-overview');
  await tab(page, L.nodes);
  await shot(page, 'raw-phone-23px-nodes');
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  const en = LABELS.en;
  const de = { ...en, ...LABELS.de };
  for (const [name, run] of [
    ['phone', () => phoneDark(browser, en)],
    ['light', () => phoneLight(browser, en)],
    ['demo', () => demo(browser)],
    ['german', () => german(browser, de)],
    ['tablet', () => tablet(browser, en)],
    ['desktop dark', () => desktop(browser, en, 'dark')],
    ['desktop light', () => desktop(browser, en, 'light')],
    ['large text', () => largeText(browser, en)],
  ]) {
    // One broken step must not cost every other screenshot.
    await run().catch((e) => errors.push(`${name}: ${e.message.split('\n')[0]}`));
  }
  console.log(errors.length ? errors.join('\n') : 'no console errors');
  await browser.close();
})();
