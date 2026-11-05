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
      // A floor, not a target: two to three points under what the suite
      // measured when it was set (statements 93.38, branches 87.73, functions
      // 95.65, lines 94.30), so a change that drops coverage fails
      // `npm run test:coverage`. Raise it when coverage rises.
      thresholds: {
        statements: 91,
        branches: 85,
        functions: 93,
        lines: 92,
      },
    },
  },
});
