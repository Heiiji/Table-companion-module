import { defineConfig } from "vite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

// package.json is the single source of truth for the version; we stamp it into
// the copied module.json at build time so the two never drift.
const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

// Foundry loads the built ESM bundle referenced by module.json (esmodules:
// ["module.js"]). We build to dist/ and copy the static assets that ship in the
// release zip alongside it, so `dist/` is a drop-in module folder for local
// testing (symlink dist/ into Foundry's Data/modules/table-companion).
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // Floor the output to a baseline the verified-v13 Electron/Chromium parses,
    // so emit can't outrun a supported client and hard-fail module load. (tsconfig
    // keeps `target: ESNext` for type-checking; this governs the actual emit.)
    target: "es2022",
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

        // Stamp the package.json version into the shipped manifest so the
        // release artifact's version is never out of sync with the source.
        const manifest = JSON.parse(readFileSync("module.json", "utf8"));
        manifest.version = pkgVersion;
        writeFileSync("dist/module.json", JSON.stringify(manifest, null, 2) + "\n");

        if (!existsSync("styles/module.css")) {
          throw new Error(
            "tca-copy-static: styles/module.css is missing (run from the repo root)",
          );
        }
        copyFileSync("styles/module.css", "dist/module.css");

        // Copy every declared locale by globbing the dir, so adding a language
        // needs no edit here — module.json's `languages` array stays the source.
        for (const file of readdirSync("lang")) {
          if (file.endsWith(".json")) {
            copyFileSync(`lang/${file}`, `dist/lang/${file}`);
          }
        }
      },
    },
  ],
});
