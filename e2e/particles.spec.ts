import { expect, type Page, test } from '@playwright/test';

/**
 * The GPU integrator (WebGPU) with 100 000 particles, checked against exact statistics: for
 * Ψ = x² + y² (k = 2) and σ = 1 the stationary variance per coordinate is σ²/(2k) = 0.25
 * (the schemes' bias at Δt = 2 ms is below 0.3 %). With 100 000 particles the estimate has a
 * standard error of about 0.45 %, so 2.5 % is a sharp test of drift, noise and random numbers.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Debug = any;
const N = 100_000;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    if (m.type() === 'warning' && m.text().includes('GPU')) errors.push(`console: ${m.text()}`); // a failed kernel check
  });
  return errors;
}

async function start(page: Page, physics: Record<string, unknown>, paintBowl = false): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as Debug).sde?.particles !== undefined);
  // Ψ = x² + y² painted on the lattice (its gradient is reproduced exactly by central differences).
  if (paintBowl) await page.evaluate(() => (window as Debug).sde.field.addFunction(-4, -4, 4, 4, (x: number, y: number) => x * x + y * y));
  if (!(await page.evaluate(() => (window as Debug).sde.state.gpu))) await page.locator('#toggle-gpu').click();
  await page.evaluate(
    ({ physics, n }) => {
      const s = (window as Debug).sde;
      s.session.apply({ physics });
      for (let i = 0; i < n; i++) s.particles.add(0, 0, i % 6);
    },
    { physics, n: N },
  );
  await page.waitForFunction(() => !(window as Debug).sde.app.formulas.waiting(), undefined, { timeout: 30_000 });
  await page.keyboard.press(' ');
}

/** Runs until simulated time `t` and checks that the GPU integrated. */
async function runOnGpu(page: Page, t: number): Promise<void> {
  await page.waitForFunction(() => (window as Debug).sde.gpu.usedLastFrame === true, undefined, { timeout: 30_000 });
  await page.waitForFunction((t) => (window as Debug).sde.particles.time > t, t, { timeout: 60_000 });
  await expect(page.locator('#integrator-note')).toContainText('on the GPU');
}

async function moments(page: Page) {
  return page.evaluate(() => {
    const ps = (window as Debug).sde.particles;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let bad = 0;
    for (let i = 0; i < ps.count; i++) {
      const x = ps.x[i];
      const y = ps.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) bad++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
    }
    const n = ps.count;
    return { n, bad, mx: sx / n, my: sy / n, vx: sxx / n - (sx / n) ** 2, vy: syy / n - (sy / n) ** 2 };
  });
}

/** Stationary variance σ²/(2k) per coordinate (k = 2), within 2.5 %. */
function expectOu(m: Awaited<ReturnType<typeof moments>>, label: string, variance = 0.25): void {
  expect(m.n, label).toBe(N);
  expect(m.bad, label).toBe(0);
  expect(Math.abs(m.mx), label).toBeLessThan(0.01);
  expect(Math.abs(m.my), label).toBeLessThan(0.01);
  expect(Math.abs(m.vx / variance - 1), `${label} Var x = ${m.vx}`).toBeLessThan(0.025);
  expect(Math.abs(m.vy / variance - 1), `${label} Var y = ${m.vy}`).toBeLessThan(0.025);
}

for (const scheme of ['heun', 'euler-maruyama', 'milstein']) {
  test(`100 000 particles on the GPU (${scheme}) relax to the exact OU variance`, async ({ page }) => {
    const errors = watchErrors(page);
    await start(page, { potentialMode: 'formula', potentialTex: 'x^2 + y^2', sigma: 1, scheme, speed: 2 });
    await runOnGpu(page, 4);
    expectOu(await moments(page), scheme);
    expect(errors).toEqual([]);
  });
}

test('the painted lattice on the GPU: a painted bowl gives the exact variance', async ({ page }) => {
  const errors = watchErrors(page);
  // The painted lattice is capped at |Ψ| ≤ 5, so the painted bowl is only 5 deep: with σ = 1 a
  // few particles in 100 000 escape over its rim within t = 4 (rate ∝ e^{−2·5/σ²}) and then
  // diffuse freely. With σ = 0.7 escapes are ~3·10⁴ times rarer; the variance is σ²/(2k) = 0.1225.
  await start(page, { potentialMode: 'painted', sigma: 0.7, scheme: 'heun', speed: 2 }, true);
  await runOnGpu(page, 4);
  expectOu(await moments(page), 'lattice', 0.1225);
  expect(errors).toEqual([]);
});

test('drift and noise formulas on the GPU (rotation keeps the Gibbs measure), Milstein', async ({ page }) => {
  const errors = watchErrors(page);
  // u = (−y, x) is divergence-free and tangent to the level sets of Ψ: the stationary law is
  // still the Gibbs measure. s₁ = s₂ = σ as formulas exercises the noise path (and ∂s for Milstein).
  await start(page, {
    potentialMode: 'formula',
    potentialTex: 'x^2 + y^2',
    sigma: 1,
    scheme: 'milstein',
    speed: 2,
    extraDrift: true,
    driftU1: '-y',
    driftU2: 'x',
    noiseFormula: true,
    noiseS1: '\\sigma',
    noiseS2: '\\sigma',
  });
  await runOnGpu(page, 4);
  expectOu(await moments(page), 'drift + noise');
  expect(errors).toEqual([]);
});

test('a window that needs every step moves the integration to the CPU and back', async ({ page }) => {
  const errors = watchErrors(page);
  await start(page, { potentialMode: 'formula', potentialTex: 'x^2 + y^2', sigma: 1 });
  await runOnGpu(page, 0.5);
  await page.locator('#passage-toggle').click(); // First passage: follows every step
  await expect(page.locator('#integrator-note')).toContainText('First passage needs every single step');
  expect(await page.evaluate(() => (window as Debug).sde.gpu.usedLastFrame)).toBe(false);
  await page.locator('#passage-toggle').click();
  await expect(page.locator('#integrator-note')).toContainText('on the GPU');
  expect(errors).toEqual([]);
});
