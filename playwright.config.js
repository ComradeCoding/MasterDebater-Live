'use strict';
//
// The browser pass, scripted. Playwright starts its own server on a spare
// port with a throwaway archive, exactly as test-clients.js does, so a run
// never touches a real archive or a server you already have open.
//
//   npm run test:browser

const os = require('os');
const path = require('path');
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.BROWSER_TEST_PORT) || 3122;

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 120000,
  // One debate at a time: the tests share a server, and the lobby is global.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.js',
    url: `http://localhost:${PORT}/arena`,
    reuseExistingServer: false,
    timeout: 20000,
    env: {
      PORT: String(PORT),
      ARCHIVE_DIR: path.join(os.tmpdir(), `debate-browser-${process.pid}`),
      // Long enough that the clock never takes the floor while a test is
      // looking at it; the protocol tests cover the clock running out.
      DEBATE_TURN_SECONDS: '60',
    },
  },
});
