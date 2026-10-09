import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Foundry's globals are reached through the typed gateway (src/foundry/runtime.ts).
// An `any` cast around one bypasses both the gateway and the lint rule that
// flags `any`, so src carries neither the cast nor the rule's opt-out.
describe("source typing", () => {
  it("src has no `any` escape hatch", () => {
    const src = new URL("../src/", import.meta.url);
    const hits = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        readFileSync(new URL(file, src), "utf8")
          .split("\n")
          .flatMap((line, i) =>
            /\bas any\b|no-explicit-any/.test(line) ? [`${file}:${i + 1}`] : [],
          ),
      );
    expect(hits).toEqual([]);
  });
});
