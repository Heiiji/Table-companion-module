import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Keep `any` flagged everywhere; the one untyped Foundry boundary
      // (DialogV2 generics in SetupApp.ts) opts out with a scoped inline
      // eslint-disable rather than disabling the rule project-wide.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests legitimately cast through `unknown` to stub Foundry globals, so the
    // strict src rules (no-explicit-any) don't apply here; we still surface
    // unused vars as a non-blocking hint.
    files: ["test/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
