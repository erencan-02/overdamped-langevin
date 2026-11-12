import { expect, type Page, test } from '@playwright/test';

/**
 * Smoke tests of the whole app: every main feature is used once through the real UI (mouse,
 * keyboard, windows, files) and checked through the debug handle `window.sde`. They guard the
 * wiring in src/main.ts and src/app/, which the unit tests do not reach.
 */

/** The debug handle `window.sde` (untyped on purpose: the tests reach into the app). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Debug = any;

/** Fails the test on any uncaught error or console error. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function open(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as Debug).sde?.particles !== undefined);
}

async function stageCentre(page: Page) {
  const box = (await page.locator('#stage').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('paint, drop particles, simulate, keys, undo', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  const c = await stageCentre(page);

  // Brush (the start tool): a stroke raises Ψ under it.
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y, { steps: 5 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  const psi = await page.evaluate(() => {
    const d = (window as Debug).sde;
    return d.potential.sample(d.camera.toWorldX(d.camera.width / 2), d.camera.toWorldY(d.camera.height / 2));
  });
  expect(psi).toBeGreaterThan(0);

  // Particles: a click drops one, a right-drag fills a rectangle.
  await page.keyboard.press('p');
  expect(await page.evaluate(() => (window as Debug).sde.state.mode)).toBe('particles');
  await page.mouse.click(c.x - 100, c.y - 50);
  expect(await page.evaluate(() => (window as Debug).sde.particles.count)).toBe(1);
  await page.mouse.move(c.x - 150, c.y - 100);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + 150, c.y + 100, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const n = await page.evaluate(() => (window as Debug).sde.particles.count);
  expect(n).toBeGreaterThan(10);

  // Undo / redo of the rectangle.
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => (window as Debug).sde.particles.count)).toBe(1);
  await page.keyboard.press('Control+y');
  expect(await page.evaluate(() => (window as Debug).sde.particles.count)).toBe(n);

  // Play (Space) and pause; one step with →.
  await page.keyboard.press(' ');
  await page.waitForFunction(() => (window as Debug).sde.particles.time > 0.2);
  await page.keyboard.press(' ');
  expect(await page.evaluate(() => (window as Debug).sde.state.playing)).toBe(false);
  const t = await page.evaluate(() => (window as Debug).sde.particles.time);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as Debug).sde.particles.time)).toBeGreaterThan(t);

  // Toggles and the scheme key.
  const before = await page.evaluate(() => {
    const s = (window as Debug).sde.state;
    return { grid: s.grid, trails: s.trails, contours: s.contours, force: s.forceField, density: s.showDensity, scheme: s.scheme };
  });
  for (const k of ['g', 't', 'l', 'f', 'd', 's']) await page.keyboard.press(k);
  const after = await page.evaluate(() => {
    const s = (window as Debug).sde.state;
    return { grid: s.grid, trails: s.trails, contours: s.contours, force: s.forceField, density: s.showDensity, scheme: s.scheme };
  });
  expect(after.grid).toBe(!before.grid);
  expect(after.trails).toBe(!before.trails);
  expect(after.contours).toBe(!before.contours);
  expect(after.force).toBe(!before.force);
  expect(after.density).toBe(!before.density);
  expect(after.scheme).not.toBe(before.scheme);
  await page.keyboard.press('b');
  expect(await page.evaluate(() => (window as Debug).sde.state.mode)).toBe('brush');

  // Clear particles (C) and Ψ (X), with undo from the keyboard.
  await page.keyboard.press('c');
  expect(await page.evaluate(() => (window as Debug).sde.particles.count)).toBe(0);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => (window as Debug).sde.particles.count)).toBe(n);

  expect(errors).toEqual([]);
});

test('record a run, list it, export it and play it back', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  await expect(page.locator('#recordings')).toBeHidden();
  const c = await stageCentre(page);
  await page.keyboard.press('p');
  await page.mouse.move(c.x - 80, c.y - 60);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + 80, c.y + 60, { steps: 4 });
  await page.mouse.up({ button: 'right' });

  await page.keyboard.press(' ');
  await page.keyboard.press('Shift+R');
  await expect(page.locator('#recordings')).toBeVisible();
  await expect(page.locator('#run-list .run.live')).toHaveCount(1);
  await page.waitForTimeout(1200);
  await page.keyboard.press('Shift+R');
  await expect(page.locator('#run-list .run:not(.live)')).toHaveCount(1);
  await expect(page.locator('#toggle-record')).toHaveAttribute('aria-pressed', 'false');

  // Export, then load the file back (playback).
  const download = page.waitForEvent('download');
  await page.locator('#run-list .run .icon-btn').first().click();
  const file = await (await download).path();
  await page.locator('#recording-input').setInputFiles(file);
  await expect(page.locator('#player')).toBeVisible();
  expect(await page.evaluate(() => (window as Debug).sde.playback.active)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#player')).toBeHidden();

  expect(errors).toEqual([]);
});

test('side windows: formulas, drift and noise, every instrument', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);

  // Potential as a formula.
  await page.locator('#potential-toggle').click();
  await page.locator('label.switch-row:has(#psi-use-formula)').click();
  await page.locator('#psi-input').fill('\\frac{x^2 + y^2}{2}');
  await page.locator('#psi-input').press('Enter');
  await page.waitForFunction(() => (window as Debug).sde.potential.analytic === true, undefined, { timeout: 30_000 });
  expect(await page.evaluate(() => (window as Debug).sde.state.potentialMode)).toBe('formula');

  // Drift & noise: an extra drift changes the process (and turns off the Gibbs tools).
  await page.locator('#process-toggle').click();
  await page.locator('label.switch-row:has(#proc-drift)').click();
  await page.waitForFunction(() => (window as Debug).sde.sde.extraDrift !== null, undefined, { timeout: 30_000 });
  expect(await page.evaluate(() => (window as Debug).sde.sde.capabilities.gibbs)).toBe(false);

  // Open every other window once and let the app run a few frames with them open.
  const heads = page.locator('#left-body .analysis-head[aria-expanded="false"]');
  for (let k = await heads.count(); k > 0; k--) await heads.first().click();
  await expect(page.locator('#left-body .analysis-head[aria-expanded="false"]')).toHaveCount(0);
  await page.keyboard.press(' ');
  await page.waitForTimeout(800);
  const readouts = await page.evaluate(() => (window as Debug).sde.instruments.readouts());
  expect(Object.keys(readouts).length).toBeGreaterThan(0);

  // The tools header folds them all.
  await page.locator('#left-toggle').click();
  await expect(page.locator('#left-body')).toBeHidden();

  expect(errors).toEqual([]);
});

test('scenario from the address, 3D view, tutorial and help', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/#scenario=ornstein-uhlenbeck');
  await expect(page.locator('#scenario')).toContainText('Ornstein');
  await page.waitForFunction(() => (window as Debug).sde.particles.count > 0);

  // 3D needs the GPU (headless Chrome may only offer software WebGL: switch it on).
  const gpu = await page.evaluate(() => (window as Debug).sde.state.gpu);
  if (!gpu) await page.locator('#toggle-gpu').click();
  await page.keyboard.press('3');
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas.view3d')?.style.opacity === '1', undefined, {
    timeout: 30_000,
  });
  await page.keyboard.press('r'); // reset view: the 3D view follows
  await page.keyboard.press('2');
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas.view3d')?.hidden === true);

  // Tutorial: the book button, Escape ends it.
  await page.locator('#tour-btn').click();
  await expect(page.locator('.tour')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tour')).toHaveCount(0);

  // Help dialog.
  await page.keyboard.press('?');
  await expect(page.locator('#help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help')).toBeHidden();

  expect(errors).toEqual([]);
});
