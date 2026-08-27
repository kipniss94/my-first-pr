import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * Some environments ship a browser that Playwright did not download itself
 * (a locked-down CI image, a corporate proxy that blocks the CDN). Point these
 * at an existing binary instead of failing.
 */
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const firefoxPath = process.env.PLAYWRIGHT_FIREFOX_PATH;

const chromiumLaunch = {
  args: [
    // Headless Chromium needs a software rasteriser for WebGL 2.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    // Containers commonly run as root, where Chromium's own sandbox refuses to
    // start. Only relaxed for a browser the operator supplied deliberately.
    ...(chromiumPath ? ['--no-sandbox'] : []),
  ],
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
};

/**
 * End-to-end checks run against the real stack: a real API, a real processing
 * layer, real fixture files. Nothing here is mocked, because the thing worth
 * testing is exactly the part that would be mocked away.
 *
 * Start both services first (`npm run dev`, or `npm start` after a build),
 * generate the fixtures (`npm run fixtures`), then `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: chromiumLaunch,
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          ...(firefoxPath ? { executablePath: firefoxPath } : {}),
          firefoxUserPrefs: {
            'webgl.force-enabled': true,
            'webgl.disabled': false,
            'gfx.webrender.all': true,
          },
        },
      },
    },
    {
      // Chromium-based so it runs anywhere the desktop project runs.
      name: 'mobile',
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices['Pixel 7'], launchOptions: chromiumLaunch },
    },
  ],
});
