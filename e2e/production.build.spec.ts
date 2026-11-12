import fs from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * The production build (as GitHub Pages serves it) with its bundled workers: the GPU integrator
 * (worker + WebGPU kernel, checked statistically) and the GIF encoder (worker), and the
 * lazily loaded SVG export.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Debug = any;

test('GPU integrator, GIF recording and SVG export work in the build', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && m.text().includes('GPU'))) errors.push(`console: ${m.text()}`);
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as Debug).sde?.particles !== undefined);
  if (!(await page.evaluate(() => (window as Debug).sde.state.gpu))) await page.locator('#toggle-gpu').click();

  // 100 000 particles in Ψ = x² + y², σ = 1: stationary variance 0.25 per coordinate.
  await page.evaluate(() => {
    const s = (window as Debug).sde;
    s.session.apply({ physics: { potentialMode: 'formula', potentialTex: 'x^2 + y^2', sigma: 1, speed: 2 } });
    for (let i = 0; i < 100_000; i++) s.particles.add(0, 0, i % 6);
  });
  await page.waitForFunction(() => !(window as Debug).sde.app.formulas.waiting(), undefined, { timeout: 30_000 });
  await page.keyboard.press(' ');
  await page.waitForFunction(() => (window as Debug).sde.gpu.usedLastFrame === true, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => (window as Debug).sde.particles.time > 4, undefined, { timeout: 60_000 });
  const v = await page.evaluate(() => {
    const ps = (window as Debug).sde.particles;
    let s = 0;
    for (let i = 0; i < ps.count; i++) s += ps.x[i] * ps.x[i] + ps.y[i] * ps.y[i];
    return s / ps.count / 2;
  });
  expect(Math.abs(v / 0.25 - 1)).toBeLessThan(0.025);

  // GIF (encoded in its worker).
  await page.locator('#menu-btn').click();
  await page.locator('#menu [data-action="record-gif"]').click();
  await expect(page.locator('.video-chip')).toContainText('GIF 0:01', { timeout: 10_000 });
  const gifDownload = page.waitForEvent('download');
  await page.locator('.video-chip button').click();
  const gif = fs.readFileSync((await (await gifDownload).path())!);
  expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');

  // SVG export of the KL plot (svgcanvas is loaded on first use).
  const kl = page.locator('#analysis');
  if ((await kl.locator('.analysis-head').getAttribute('aria-expanded')) === 'false') await kl.locator('.analysis-head').click();
  await kl.locator('.plot-wrap').hover();
  const svgDownload = page.waitForEvent('download');
  await kl.locator('.plot-export').click();
  await kl.locator('.plot-export-menu button', { hasText: 'SVG' }).click();
  const svg = fs.readFileSync((await (await svgDownload).path())!).toString('utf8');
  expect(svg).toContain('<svg');
  expect(svg).toContain('Distance to equilibrium');

  expect(errors).toEqual([]);
});
