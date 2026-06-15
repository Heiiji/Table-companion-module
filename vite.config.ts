import { defineConfig } from "vite";
import { copyFileSync, mkdirSync } from "node:fs";

// Foundry loads the built ESM bundle referenced by module.json (esmodules:
// ["module.js"]). We build to dist/ and copy the static assets that ship in the
// release zip alongside it, so `dist/` is a drop-in module folder for local
// testing (symlink dist/ into Foundry's Data/modules/table-companion).
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: "src/module.ts",
      formats: ["es"],
      fileName: () => "module.js",
    },
  },
  plugins: [
    {
      name: "tca-copy-static",
      closeBundle() {
        mkdirSync("dist/lang", { recursive: true });
        copyFileSync("module.json", "dist/module.json");
        copyFileSync("styles/module.css", "dist/module.css");
        copyFileSync("lang/en.json", "dist/lang/en.json");
        copyFileSync("lang/fr.json", "dist/lang/fr.json");
      },
    },
  ],
});
