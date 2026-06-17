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
    },
  },
});
