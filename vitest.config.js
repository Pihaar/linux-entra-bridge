import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["tests/js/setup.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage/js",
      include: ["extension/**/*.js"],
      exclude: ["extension/icons/**", "extension/*-init.js"],
    },
  },
});
