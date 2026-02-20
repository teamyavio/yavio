import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
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
