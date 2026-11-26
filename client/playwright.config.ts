import { defineConfig } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // Calls are timing-sensitive; run one at a time so peers never compete for CPU.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: isCI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://localhost:1420',
    // Locally drive the installed Chrome; CI installs Playwright's Chromium.
    channel: isCI ? undefined : 'chrome',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420/e2e/harness.html',
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
