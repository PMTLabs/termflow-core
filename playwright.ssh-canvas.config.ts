import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ssh-canvas',
  outputDir: './test-results/ssh-canvas',
  globalSetup: './tests/ssh-canvas/fixture/global-setup.ts',
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  use: { screenshot: 'only-on-failure', viewport: { width: 1600, height: 1000 } },
  // D58: use installed Chromium. WebKit is not run here; the Mac WKWebView live check covers it.
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
