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
    /*
     * Two suites, deliberately separate. `unit` is the fast one and needs
     * nothing but a process; `integration` starts a real S3-compatible store in
     * a container and skips itself when there is no container runtime to start
     * it in.
     */
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/integration/**"],
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
    ],
  },
});
