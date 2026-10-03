import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/online",
  // Real provider/database requests can include a full safe retry window.
  timeout: 300_000,
  expect: { timeout: 60_000 },
  workers: 1,
  use: {
    baseURL: "http://localhost:3102",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    // Auth requests contain credentials. Do not persist browser traces.
    trace: "off",
  },
  webServer: {
    command: "npm run dev -- --port 3102", url: "http://localhost:3102",
    reuseExistingServer: true, timeout: 120_000,
  },
});
