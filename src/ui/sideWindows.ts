import * as kit from './panelKit';

/**
 * The markup of the side windows that are not instruments of their own (potential, drift &
 * noise, birth / death, observable, KL to equilibrium, settings), built with the panel kit in
 * their order on the page. Call once at start-up, before the classes that run the windows look
 * up their elements; the ids are the contract between this markup and those classes.
 *
 * Windows added later (the instruments, which build themselves) are placed among these with
 * `before: 'analysis'` (above KL to equilibrium).
 */
export function buildSideWindows(): void {
  potential();
  process();
  birthDeath();
  observable();
  equilibrium();
  settings();
}

/** ρ̂_h, the smoothed empirical measure (a new element for every use). */
const rhoH = () => kit.tex('\\hat{\\rho}_h', ['ρ̂', kit.sub('h')]);

function potential(): void {
  const { body } = kit.createPanel({ id: 'potential', title: 'Potential Ψ', label: 'Potential', value: 'psi-mode' });
  kit.switchRow(body, { id: 'psi-use-formula', label: 'Use a formula instead of painting' });
  kit.formulaField(body, {
    id: 'psi-input',
    errorId: 'psi-error',
    label: 'Ψ(t, x, y)',
    examples: [
      ['harmonic', '\\frac{x^2 + y^2}{2}'],
      ['double well', '\\frac{(x^2 - 4)^2}{16} + \\frac{y^2}{2}'],
      ['ring', '\\frac{(r^2 - 4)^2}{16}'],
      ['egg crate', '-\\cos(2x)\\cos(2y) + \\frac{r^2}{20}'],
      ['moving well (t)', '\\frac{(x - 2\\cos t)^2 + (y - 2\\sin t)^2}{2}'],
      ['rocking (t)', '\\frac{(x^2 - 4)^2}{16} + \\frac{y^2}{2} + \\frac{x \\sin t}{2}'],
    ],
  });
  kit.headLine(body, {
    cls: 'psi-norm',
    label: kit.tex('\\lVert \\nabla\\Psi \\rVert_{L^2(B)}', ['‖∇Ψ‖', kit.sub('L²(B)')]),
    outputId: 'psi-norm',
    outputText: '—',
  });
  kit.note(body, 'L² norm of the gradient field over the dashed box B.');
  kit.info(body, 'psi-info');
}

function process(): void {
  const { body } = kit.createPanel({ id: 'process', title: 'Drift & noise', label: 'Drift and noise', value: 'process-kind' });
  const eq = kit.group(body, 'process-eq');
  eq.append(
    kit.tex(
      'dX_t = \\bigl(-\\nabla\\Psi + u\\bigr)(t, X_t)\\,dt + \\operatorname{diag}(s_1, s_2)(t, X_t)\\,dW_t',
      'dX = (−∇Ψ + u) dt + diag(s₁, s₂) dW',
    ),
  );
  const pair = (part: string, items: [string, string, string][]) =>
    items.map(([label, first, second]) => ({ label, data: { part, first, second } }));
  kit.switchRow(body, { id: 'proc-drift', label: 'Add a drift u(t, x, y)' });
  kit.formulaField(body, { id: 'proc-u1', rootId: 'proc-u1-field', label: 'u₁(t, x, y)' });
  kit.formulaField(body, { id: 'proc-u2', rootId: 'proc-u2-field', label: 'u₂(t, x, y)', note: null });
  kit.exampleButtons(
    body,
    'Example drifts',
    pair('drift', [
      ['rotation', '-y', 'x'],
      ['shear', 'y', '0'],
      ['constant', '1', '0'],
      ['rotation (t)', '-y\\cos t', 'x\\cos t'],
    ]),
  );
  kit.switchRow(body, { id: 'proc-noise', label: 'State-dependent noise s(t, x, y)' });
  kit.formulaField(body, { id: 'proc-s1', rootId: 'proc-s1-field', label: 's₁(t, x, y)' });
  kit.formulaField(body, { id: 'proc-s2', rootId: 'proc-s2-field', label: 's₂(t, x, y)', note: null });
  kit.exampleButtons(
    body,
    'Example noise',
    pair('noise', [
      ['multiplicative', '\\sigma\\sqrt{1 + \\frac{x^2}{4}}', '\\sigma\\sqrt{1 + \\frac{y^2}{4}}'],
      ['geometric', '\\sigma x', '\\sigma y'],
      ['anisotropic', '\\sigma', '\\frac{\\sigma}{4}'],
      ['pulsing (t)', '\\sigma\\left(1 + \\frac{1}{2}\\sin t\\right)', '\\sigma\\left(1 + \\frac{1}{2}\\sin t\\right)'],
    ]),
  );
  kit.note(body, 'Itô SDE with diagonal noise. Off: u = 0 and s₁ = s₂ = σ (the Langevin equation).');
  kit.info(body, 'process-info');
}

function birthDeath(): void {
  const { body } = kit.createPanel({ id: 'birthdeath', title: 'Birth / death', label: 'Birth and death', value: 'bd-value' });
  kit.switchRow(body, { id: 'bd-enabled', label: 'Births and deaths' });
  const rates = kit.group(body, 'bd-rates');
  const rate = (id: string, label: string) =>
    kit.formulaField(rates, { id, rootId: `${id}-field`, label, note: null, preview: false, inputMode: 'decimal' });
  rate('bd-birth', 'Birth rate λ');
  rate('bd-death', 'Death rate μ');
  kit.note(body, "Per particle and unit of simulated time. A birth adds a particle at the parent's position, a death removes the particle.");
  kit.caption(body, 'Number of particles over simulated time');
  kit.plotCanvas(body, 'Number of particles over time', 'bd-plot');
  kit.legend(body, [
    ['line', 'particles N(t)'],
    ['dash', ['expected N₀ e', kit.sup('(λ−μ)t')]],
    ['band', '5–95 % of 200 runs'],
  ]);
  kit.info(body, 'bd-info');
  kit.buttons(body, ['Reset plot'], ['bd-reset']);
}

function observable(): void {
  const { body } = kit.createPanel({
    id: 'observable',
    title: ['Observable 𝔼[f(X', kit.sub('t'), ')]'],
    label: 'Custom observable',
    value: 'obs-value',
  });
  kit.formulaField(body, {
    id: 'obs-input',
    errorId: 'obs-error',
    label: 'Test function f(x, y)',
    value: 'x^2 + y^2',
    examples: [
      ['x', 'x'],
      ['r²', 'x^2 + y^2'],
      ['𝟏{x>0}', '\\mathbf{1}_{x > 0}'],
      ['cos πx', '\\cos(\\pi x)'],
      ['Ψ', '\\Psi'],
    ],
  });
  kit.caption(body, 'Mean of f over the particles inside the dashed box, over simulated time');
  kit.plotCanvas(body, 'Expectation of f over time', 'obs-plot');
  kit.legend(body, [
    ['line', 'particle mean'],
    ['band', '95 % CI'],
    ['dash', 'exact ∫ f dπ'],
  ]);
  kit.info(body, 'obs-info');
  kit.buttons(body, ['Fit box to view', 'Reset plot'], ['obs-fit', 'obs-reset']);
}

function equilibrium(): void {
  const { body } = kit.createPanel({ id: 'analysis', title: 'KL to equilibrium', label: 'Distance to equilibrium', value: 'kl-value' });
  kit.caption(body, ['KL(', rhoH(), ' ‖ π) inside the dashed box, over simulated time']);
  kit.plotCanvas(body, 'KL divergence over time', 'kl-plot');
  kit.legend(body, [
    ['line', 'particles ∗ kernel vs Gibbs'],
    ['dash', 'smoothing floor'],
  ]);
  kit.switchRow(body, { id: 'show-density', label: ['Show ', rhoH(), ' on the scene ', kit.kbd('D')] });
  kit.rangeField(body, { id: 'kernel-var', label: 'Kernel variance h²', outputId: 'kernel-var-out' });
  kit.info(body, 'kl-info');
  kit.buttons(body, ['Fit box to view', 'Reset plot'], ['kl-fit', 'kl-reset']);
}

function settings(): void {
  const { body } = kit.createPanel({
    id: 'settings',
    title: 'Settings',
    label: 'Settings',
    value: false,
    bodyId: 'panel',
    bodyClass: 'panel',
    cardClass: 'settings',
    open: true,
  });
  kit.rangeField(body, { id: 'sigma', label: ['Diffusivity ', mathItalic('σ')], outputId: 'sigma-out' });
  kit.rangeField(body, { id: 'speed', label: 'Speed', outputId: 'speed-out' });

  // Numerical scheme: three radio buttons (Controls wires them by data-scheme).
  const scheme = kit.group(body, 'field');
  const head = kit.group(scheme, 'field-head');
  head.append(span('Numerical scheme'), kit.kbd('S'));
  const seg = kit.group(scheme, 'mini-seg', { role: 'radiogroup', 'aria-label': 'Numerical scheme' });
  for (const [id, label, title] of [
    ['heun', 'Heun', 'Stochastic Heun'],
    ['euler-maruyama', 'Euler–M.', 'Euler–Maruyama'],
    ['milstein', 'Milstein', 'Milstein'],
  ]) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.dataset.scheme = id;
    b.title = title;
    b.textContent = label;
    seg.append(b);
  }
  kit.note(scheme, '', 'scheme-note');

  // Seed.
  const seed = document.createElement('label');
  seed.className = 'field seed-field';
  const seedHead = document.createElement('span');
  seedHead.className = 'field-head';
  seedHead.append(span('Seed'));
  const seedInput = document.createElement('input');
  Object.assign(seedInput, { type: 'number', id: 'seed', min: '0', max: '4294967295', step: '1', value: '0', inputMode: 'numeric' });
  const seedNote = document.createElement('span');
  seedNote.className = 'field-note';
  seedNote.textContent = 'Same seed and same actions give exactly the same run.';
  seed.append(seedHead, seedInput, seedNote);
  body.append(seed);

  // Tool settings, shown for the active tool only (Controls shows/hides .mode-only).
  const brush = kit.group(body, 'mode-only');
  brush.dataset.for = 'brush';
  kit.group(brush, 'panel-sep');
  kit.rangeField(brush, { id: 'brush-size', label: 'Brush size', outputId: 'brush-size-out' });
  kit.rangeField(brush, { id: 'brush-strength', label: 'Brush strength', outputId: 'brush-strength-out' });

  const particles = kit.group(body, 'mode-only');
  particles.dataset.for = 'particles';
  kit.group(particles, 'panel-sep');
  kit.headLine(particles, { label: 'Particles', outputId: 'particle-count' });
  kit.rangeField(particles, {
    id: 'grid-spacing',
    label: 'Grid spacing',
    outputId: 'grid-spacing-out',
    note: 'Right-drag a rectangle to fill it with particles at this spacing.',
  });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.id = 'clear-particles';
  clear.className = 'ghost-btn';
  clear.textContent = 'Clear particles';
  particles.append(clear);
}

function span(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

function mathItalic(text: string): HTMLElement {
  const i = document.createElement('i');
  i.className = 'math';
  i.textContent = text;
  return i;
}
