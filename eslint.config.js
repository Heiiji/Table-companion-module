import tseslint from "@typescript-eslint/eslint-plugin";

// Flat config built from @typescript-eslint/eslint-plugin's own flat presets.

const SOURCES = ["src/**/*.ts", "test/**/*.ts"];
const CONFIG_FILES = ["eslint.config.js", "vite.config.ts", "vitest.config.ts"];

/** One of the plugin's flat presets, applied to exactly these files. */
const scoped = (preset, files) =>
  preset.map((config) => ({ ...config, files }));

export default [
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },

  // The build and tool configs: the recommended rules, without type information
  // (they sit outside the TypeScript projects).
  ...scoped(tseslint.configs["flat/recommended"], CONFIG_FILES),

  // src and test: the recommended rules plus the type-aware promise rules. The
  // project service finds tsconfig.json for src and test/tsconfig.json (which
  // extends tsconfig.test.json) for the tests.
  ...scoped(tseslint.configs["flat/recommended"], SOURCES),
  {
    files: SOURCES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise nobody awaits or catches loses its rejection; a promise passed
      // where a callback's result is ignored does the same.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Keep `any` flagged; the one untyped Foundry boundary (module.ts's
      // ApplicationV2 lookup) opts out with a scoped inline disable.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests cast through `unknown` and stub Foundry globals loosely.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
