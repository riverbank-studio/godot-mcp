import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // src/scripts/ holds the bundled GDScript runner, not TS — exclude from coverage.
      exclude: ["src/**/*.{test,spec}.ts", "src/scripts/**"],
      reporter: ["text", "html"],
    },
  },
});
