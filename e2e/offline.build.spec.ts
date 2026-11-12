import { expect, test } from '@playwright/test';

/**
 * The offline app (production build): after one visit, the app, its lazily loaded parts and the
 * course scenarios work without any network.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Debug = any;

test('works offline after the first visit, and is installable', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  await page.waitForFunction(() => (window as Debug).sde?.particles !== undefined);
  // The service worker has kept every file (it controls the page once it is active).
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated');
  await expect(page.locator('#toast')).toContainText('available offline', { timeout: 30_000 });

  // Installable: a manifest with icons and a start URL.
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
    return (await fetch(href)).json();
  });
  expect(manifest.name).toBe('Langevin Dynamics');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));

  // No network from here on (fonts and everything else come from the caches).
  await context.setOffline(true);

  // A scenario from the address, offline: the page, the scenario file and its windows.
  await page.goto('/?embed#scenario=metastability');
  await page.waitForFunction(() => (window as Debug).sde?.particles?.count > 0, undefined, { timeout: 30_000 });
  await expect(page.locator('#scenario')).toContainText('Metastability');
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true); // served by the service worker
  // Its formula Ψ needs the formula engine (a lazily loaded chunk).
  await page.waitForFunction(() => (window as Debug).sde.potential.analytic === true, undefined, { timeout: 30_000 });

  // The help dialog typesets its formulas with KaTeX (another lazily loaded chunk and fonts).
  await page.keyboard.press('?');
  await expect(page.locator('#help .katex').first()).toBeVisible({ timeout: 30_000 });

  // The course library lists the scenarios (scenarios/index.json from the cache).
  await page.keyboard.press('Escape');
  await expect(page.locator('.sc-library button').first()).toBeAttached();

  expect(errors).toEqual([]);
});
