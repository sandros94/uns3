import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  /*
   * Lets a local `.env` carry the `UNS3_TEST_*` variables that point the
   * integration battery at an external store. Nothing else is read from it.
   */
  envPrefix: "UNS3_TEST_",
  test: {
    slowTestThreshold: 2000,
    coverage: {
      exclude: ["dist/**", "test/**", "build.config.ts", "vitest.config.ts"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/integration/**", "test/browser/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          /* Pulling and booting a store is minutes, not milliseconds. */
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          globalSetup: ["test/browser/_echo-server.ts"],
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            provider: playwright(),
            instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
          },
        },
      },
    ],
  },
});
