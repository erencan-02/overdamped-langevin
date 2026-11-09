# Potential SDE

An interactive, real-time simulator of the overdamped Langevin equation

```math
dX_t = -\nabla\Psi(X_t)\,dt + \sigma\,dW_t ,\qquad X_t\in\mathbb{R}^2
```

on a potential landscape $\Psi$ that you paint with the mouse. Hills (warm colours, $\Psi>0$) push
particles away, valleys (cool colours, $\Psi<0$) attract them, and Brownian noise with diffusivity
$\sigma$ shakes them around. Everything can be changed while the simulation is running.

It is a static site with no backend, so it runs on GitHub Pages.
**Try it live: <https://erencan-02.github.io/overdamped-langevin/>**

<table>
  <tr>
    <td width="50%"><img src="docs/media/landscape.gif" alt="100 particles drifting into the valleys of a random potential landscape" width="100%"></td>
    <td width="50%"><img src="docs/media/landscape-force-field.gif" alt="The same run with the force field −∇Ψ drawn as arrows" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><sub>Random landscape, 100 particles, σ = 0.6</sub></td>
    <td align="center"><sub>Same run with the force field −∇Ψ switched on</sub></td>
  </tr>
</table>

## Using it

| Action | How |
| --- | --- |
| Switch tool | **Brush** / **Particles** in the toolbar (or <kbd>B</kbd> / <kbd>P</kbd>) |
| Raise Ψ | Brush mode, hold the **left** mouse button |
| Lower Ψ | Brush mode, hold the **right** mouse button |
| Drop a particle | Particle mode, **click** |
| Spray particles | Particle mode, **Shift + drag** |
| Remove a particle | Particle mode, **right-click** it |
| Pan | Hold the **mouse wheel** and drag (or **Alt + drag**) |
| Zoom | **Scroll** |
| Play / pause | **Play** button or <kbd>Space</kbd> |
| Grid / trails / contours | Toolbar toggles or <kbd>G</kbd> / <kbd>T</kbd> / <kbd>L</kbd> |
| Force field −∇Ψ (arrows) | Toolbar toggle or <kbd>F</kbd> |
| Image → Ψ | **Drop an image** anywhere, or Scene menu → *Import image…* (<kbd>I</kbd>) |
| Numerical scheme | Heun / Euler–Maruyama toggle in the panel, or <kbd>S</kbd> |
| Presets, clear, reset view | Scene menu (layers icon), <kbd>C</kbd> clear particles, <kbd>X</kbd> clear Ψ, <kbd>R</kbd> reset view |

The panel at the bottom left sets the diffusivity σ, the simulation speed, the numerical scheme and the brush size
(standard deviation of the Gaussian brush) and strength (rate of change of Ψ at the brush centre).
$|\Psi|$ is capped at 5.

## How it works

**Potential.** Ψ lives on a regular lattice (spacing $h = 0.04$) split into lazily allocated
128 × 128 chunks, so the plane is effectively unbounded and memory only grows with the painted area.
The brush adds a Gaussian bump $A\thinspace e^{-r^2/2s^2}$ and clamps the result to $[-5, 5]$. The nodal
gradient is kept up to date with second-order central differences and bilinearly interpolated,
which gives a continuous drift field with $O(h^2)$ error.

**Images as potentials.** A dropped image is decoded in a Web Worker (`createImageBitmap` +
`OffscreenCanvas`, with an `<img>` fallback, e.g. for SVG), resampled to the potential grid with
step-wise downscaling, and converted to perceptual lightness (CIE L\*). After a robust contrast
stretch (1st–99th percentile), dark pixels become valleys down to $-5$, light pixels stay flat and
transparent pixels are ignored, so the Gibbs density $\propto e^{-2\Psi/\sigma^2}$ concentrates on
the dark parts of the picture. A Gaussian blur of about three grid cells keeps forces and
curvatures within what the time step can handle. *Invert* swaps light and dark. Everything runs
in the browser: nothing is uploaded.

**Numerical schemes.** Two interchangeable schemes are implemented in `src/sim/schemes.ts`
behind a common interface. Switch between them with the toggle in the panel or <kbd>S</kbd>,
even while the simulation is running:

| | Update | Force evaluations / step |
| --- | --- | --- |
| **Euler–Maruyama** | $X_{n+1} = X_n - \nabla\Psi(X_n)\thinspace \Delta t + \sigma\thinspace \Delta W$ | 1 |
| **Stochastic Heun** (default) | $\tilde X = X_n - \nabla\Psi(X_n)\thinspace \Delta t + \sigma\thinspace \Delta W$, then $X_{n+1} = X_n - \tfrac12\big[\nabla\Psi(X_n) + \nabla\Psi(\tilde X)\big]\Delta t + \sigma\thinspace \Delta W$ | 2 |

with $\Delta W \sim \mathcal N(0, \Delta t\thinspace  I)$, the same increment in both Heun stages. Because the noise
is additive (σ is constant), **both schemes have strong order 1**. The difference is in the drift:
Euler–Maruyama is first order there, while Heun is second order (and is reported to have weak
order 2 for additive noise). Heun is therefore much more accurate where the force dominates the
noise, at twice the cost per step. Sub-steps are at most 2 ms of simulated time. If thousands of
particles would overrun the frame, the step grows up to a hard limit of 10 ms, and past that the
simulation slows down rather than losing accuracy. The work budget is counted in force evaluations
and adapts to the measured speed of the device, so Euler–Maruyama automatically gets twice as many
sub-steps. Gaussian increments come from a ziggurat sampler on a seedable xoshiro128** generator.

**Rendering.** WebGL2 throughout: one half-float texture per chunk (with a shared border row/column
for seamless bilinear filtering) coloured by a diverging colormap with optional iso-contours, a
procedural adaptive grid, a force-field overlay (instanced arrows drawn as signed-distance shapes on a
power-of-two lattice fixed in world space, rebuilt only when the view or Ψ changes), instanced particle sprites, and trails whose ring-buffer history is kept on
the GPU. Only the newly recorded column is uploaded each frame.

**Tests.** `npm test` checks the field discretisation against analytic Gaussians, the normal
sampler's moments and tails, free Brownian motion ($\mathrm{Var}\thinspace X_t=\sigma^2 t$), the exact
deterministic gradient flow, and relaxation to the Gibbs distribution of an Ornstein–Uhlenbeck
process ($\mathrm{Var}=\sigma^2/2k$). For the schemes, it measures the convergence order in the
drift (halving Δt divides the error by 2 for Euler–Maruyama and by 4 for Heun) and checks that each
scheme reproduces its own exact discrete stationary variance for the OU process.

## Development

```bash
npm install
npm run dev      # local dev server
npm test         # unit and statistical tests
npm run build    # static build in dist/
```

Pushing to `main` builds, tests and deploys the site to GitHub Pages through
`.github/workflows/deploy.yml`.

## Project layout

```
src/
  sim/field.ts        chunked potential grid, brush, gradient
  sim/particles.ts    particle ensemble: state, sub-stepping, trails
  sim/schemes.ts      numerical schemes (Euler–Maruyama, stochastic Heun)
  sim/rng.ts          xoshiro128** + ziggurat normal sampler
  sim/presets.ts      ready-made landscapes
  render/             WebGL2 renderer and shaders
  view/               camera, grid spacing, 2D overlay (labels, cursor)
  ui/                 pointer input and DOM controls
  main.ts             wiring and the frame loop
tests/                vitest suites
```
