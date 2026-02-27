import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
    projects: [
      defineProject({
        test: {
          name: "node",
          include: ["src/__tests__/**/*.test.ts"],
          exclude: ["src/__tests__/react/**"],
        },
      }),
      defineProject({
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/__tests__/react/**/*.test.ts"],
        },
      }),
    ],
  },
});
