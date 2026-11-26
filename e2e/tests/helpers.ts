import { expect, Locator, Page } from '@playwright/test';

/** Ionic keeps earlier pages in the DOM; the visible one is the last page that is not hidden. */
export function visiblePage(page: Page): Locator {
  return page.locator('ion-router-outlet > .ion-page:not(.ion-page-hidden)').last();
}

export async function openTab(page: Page, label: string): Promise<void> {
  await visiblePage(page).locator('ion-segment-button', { hasText: label }).first().click();
}

/** Toasts render outside the page; this waits for one with the text. */
export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('ion-toast').filter({ hasText: text }).first()).toBeVisible();
}

/** Collects console errors and page crashes, so a test can assert none happened. */
export function watchErrors(page: Page, ignore: RegExp[] = []): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignore.some((r) => r.test(m.text()))) {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}
