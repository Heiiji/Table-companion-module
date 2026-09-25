import { defineConfig } from "vitest/config";

// Standalone test config (kept separate from vite.config.ts so the library
// build + static-copy plugin don't run during tests). The source uses
// `.js`-suffixed relative imports that resolve to the `.ts` files; Vite's
// resolver handles that out of the box.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      // A floor, not a target: one point under what the suite measured when it
      // was set (statements 74.39, branches 74.14, functions 75.63, lines
      // 75.46), so a change that drops coverage fails `npm run test:coverage`.
      // Raise it when coverage rises.
      thresholds: {
        statements: 73,
        branches: 73,
        functions: 74,
        lines: 74,
      },
    },
  },
});
