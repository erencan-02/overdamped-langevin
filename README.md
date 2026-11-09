# Potential SDE

An interactive, real-time simulator of the overdamped Langevin equation

$$
dX_t = -\nabla\Psi(X_t)\,dt + \sigma\,dW_t ,\qquad X_t\in\mathbb{R}^2
$$

on a potential landscape $\Psi$ that you paint with the mouse. Hills (warm colours, $\Psi>0$) push
particles away, valleys (cool colours, $\Psi<0$) attract them, and Brownian noise with diffusivity
$\sigma$ shakes them around. Everything can be changed while the simulation is running.

It is a static site with no backend, so it runs on GitHub Pages.

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
| Presets, clear, reset view | Scene menu (layers icon), <kbd>C</kbd> clear particles, <kbd>X</kbd> clear Ψ, <kbd>R</kbd> reset view |

The panel at the bottom left sets the diffusivity σ, the simulation speed and the brush size
(standard deviation of the Gaussian brush) and strength (rate of change of Ψ at the brush centre).
$|\Psi|$ is capped at 5.

## How it works

**Potential.** Ψ lives on a regular lattice (spacing $h = 0.04$) split into lazily allocated
128 × 128 chunks, so the plane is effectively unbounded and memory only grows with the painted area.
The brush adds a Gaussian bump $A\,e^{-r^2/2s^2}$ and clamps the result to $[-5, 5]$. The nodal
gradient is kept up to date with second-order central differences and bilinearly interpolated,
which gives a continuous drift field with $O(h^2)$ error.

**Integrator.** Particles are advanced with the stochastic Heun (predictor–corrector) scheme

$$
\tilde X = X_n - \nabla\Psi(X_n)\,\Delta t + \sigma\,\Delta W,\qquad
X_{n+1} = X_n - \tfrac12\big[\nabla\Psi(X_n) + \nabla\Psi(\tilde X)\big]\Delta t + \sigma\,\Delta W ,
$$

which for additive noise has strong order 1 (Euler–Maruyama has 1/2) and weak order 2. Sub-steps are
at most 2 ms of simulated time. If thousands of particles would overrun the frame, the step grows up
to a hard limit of 10 ms, and past that the simulation slows down rather than losing accuracy. The
work budget adapts to the measured speed of the device. Gaussian increments come from a ziggurat
sampler on a seedable xoshiro128** generator.

**Rendering.** WebGL2 throughout: one half-float texture per chunk (with a shared border row/column
for seamless bilinear filtering) coloured by a diverging colormap with optional iso-contours, a
procedural adaptive grid, instanced particle sprites, and trails whose ring-buffer history is kept on
the GPU. Only the newly recorded column is uploaded each frame.

**Tests.** `npm test` checks the field discretisation against analytic Gaussians, the normal
sampler's moments and tails, free Brownian motion ($\mathrm{Var}\,X_t=\sigma^2 t$), the exact
deterministic gradient flow, and relaxation to the Gibbs distribution of an Ornstein–Uhlenbeck
process ($\mathrm{Var}=\sigma^2/2k$).

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
  sim/particles.ts    particle ensemble + stochastic Heun integrator
  sim/rng.ts          xoshiro128** + ziggurat normal sampler
  sim/presets.ts      ready-made landscapes
  render/             WebGL2 renderer and shaders
  view/               camera, grid spacing, 2D overlay (labels, cursor)
  ui/                 pointer input and DOM controls
  main.ts             wiring and the frame loop
tests/                vitest suites
```
