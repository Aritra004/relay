import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["**/development/**", "**/online/**"],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  // Build separately so this always tests production code and its precache list.
  webServer: {
    command: "npm run start -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
