import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/** Pre-installed Chromium in managed environments; CI installs Playwright's own (`playwright install chromium`). */
const LOCAL_CHROMIUM = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    ...devices['Desktop Chrome'],
    launchOptions: existsSync(LOCAL_CHROMIUM) ? { executablePath: LOCAL_CHROMIUM } : {},
  },
  webServer: {
    // The API is mocked in the browser (page.route); the server only renders pages and runs the BFF.
    command: 'pnpm start',
    url: 'http://127.0.0.1:3100/en/login',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      WEB_API_URL: 'http://127.0.0.1:9/api/v1',
      WEB_REALTIME_URL: 'ws://127.0.0.1:3100/realtime-mock',
    },
  },
});
