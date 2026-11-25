// Shared by the documentation screenshots (capture.cjs) and the store
// screenshots (scripts/store-screenshots/): pairing with the demo agents of
// run.sh and finding one's way around the app.
// Demo agents take any pairing code; the key is pinned like in a real pairing link.
const CODE = 'DEMO000000';
const keyOf = async (port) => (await (await fetch(`http://localhost:${port}/api/identity`)).json()).publicKey;
const BASE = 'http://localhost:8081';

// The labels the script clicks, per UI language. The app follows the browser's language.
const LABELS = {
  en: {
    logs: 'Logs before the crash', close: 'Close', restart: 'Restart social-importer', silence: 'Silence',
    services: 'Services', nodes: 'Nodes', workloads: 'Workloads', storage: 'Storage', backups: 'Backups', network: 'Network', events: 'Events',
    problems: 'Issues', all: 'All', newCode: 'Create pairing code', modules: 'Modules and actions', showAll: /Show all/,
  },
  de: { close: 'Schließen', services: 'Dienste', backups: 'Backups', showAll: /Alle \d+ zeigen|Alle/ },
};

// Ionic keeps earlier pages in the DOM; the one on top is the last visible one.
const scroll = (page, y) =>
  page
    .evaluate((y) => {
      const pages = [...document.querySelectorAll('ion-router-outlet > .ion-page:not(.ion-page-hidden)')];
      return pages[pages.length - 1].querySelector('ion-content').scrollToPoint(0, y);
    }, y)
    .then(() => page.waitForTimeout(500));
const scrollTo = async (page, selector) => {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
};
const tab = async (page, label) => {
  await page.locator('ion-segment-button', { hasText: label }).first().click();
  await page.waitForTimeout(1000);
  await scroll(page, 0);
};
const closeSheet = async (page, L) => {
  await page.locator('app-module-sheet ion-button', { hasText: L.close }).click();
  await page.waitForTimeout(700);
};

async function pairAll(page) {
  await page.goto(`${BASE}/#/pair?code=${CODE}&name=homelab&key=${await keyOf(8081)}`);
  await page.waitForSelector('app-heartbeat', { timeout: 15000 });
  for (const [port, name] of [[8082, 'office'], [8083, 'staging']]) {
    await page.goto(`${BASE}/#/pair?url=http://localhost:${port}&code=${CODE}&name=${name}&key=${await keyOf(port)}`);
    await page.waitForURL(/#\/c\//, { timeout: 15000 });
  }
  await page.goto(`${BASE}/#/clusters`);
  // A fresh load, so no page transition is still running in the picture.
  await page.reload();
  await page.waitForSelector('app-clusters app-heartbeat', { timeout: 15000 });
  await page.waitForTimeout(2500);
}

async function openCluster(page, name) {
  await page.goto(`${BASE}/#/clusters`);
  await page.reload();
  await page.waitForSelector('app-clusters a', { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.locator('app-clusters a', { hasText: name }).first().click();
  await page.waitForSelector('app-overview-tab', { timeout: 15000 });
  await page.waitForTimeout(1800);
}

module.exports = { CODE, keyOf, BASE, LABELS, scroll, scrollTo, tab, closeSheet, pairAll, openCluster };
