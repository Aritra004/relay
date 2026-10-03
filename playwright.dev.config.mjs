import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/development",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: { baseURL: "http://localhost:3101", browserName: "chromium",
    viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: { command: "npm run dev -- --port 3101", url: "http://localhost:3101",
    reuseExistingServer: false, timeout: 120_000 },
});
