import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests (e2e/): the whole app in a real browser, to catch wiring mistakes that the
 * unit tests (tests/, Vitest) cannot see. Uses the installed Chrome; run with `npm run e2e`.
 *
 *  - project "dev":   the app from the dev server (smoke tests of every feature)
 *  - project "build": the production build (what GitHub Pages serves), e.g. the offline app
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'dev', testIgnore: /\.build\.spec\.ts$/, use: { baseURL: 'http://localhost:5181' } },
    { name: 'build', testMatch: /\.build\.spec\.ts$/, use: { baseURL: 'http://localhost:5182' } },
  ],
  webServer: [
    {
      command: 'npx vite --port 5181 --strictPort',
      url: 'http://localhost:5181',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite build --logLevel error && npx vite preview --port 5182 --strictPort',
      url: 'http://localhost:5182',
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
