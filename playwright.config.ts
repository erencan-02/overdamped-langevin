import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke tests (e2e/): the whole app in a real browser, to catch wiring mistakes that
 * the unit tests (tests/, Vitest) cannot see. Uses the installed Chrome; run with `npm run e2e`.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5181',
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npx vite --port 5181 --strictPort',
    url: 'http://localhost:5181',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
