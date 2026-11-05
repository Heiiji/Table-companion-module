import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Tree = { [key: string]: string | Tree };

const load = (lang: string): Record<string, string> => {
  const flat: Record<string, string> = {};
  const walk = (node: Tree, prefix: string) => {
    for (const [key, value] of Object.entries(node))
      if (typeof value === "string") flat[prefix + key] = value;
      else walk(value, `${prefix}${key}.`);
  };
  walk(
    JSON.parse(
      readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), "utf8"),
    ) as Tree,
    "",
  );
  return flat;
};

const en = load("en");
const fr = load("fr");
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("translations", () => {
  it("have the same keys and placeholders in English and French", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en))
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
  });

  it("follow French typography", () => {
    for (const [key, text] of Object.entries(fr)) {
      // A no-break space before : ; ? ! and inside « », never a plain or a
      // narrow one; the typographic apostrophe.
      expect(text, key).not.toMatch(/[^ ][:;?!]|«[^ ]|[^ ]»/);
      expect(text, key).not.toContain("'");
    }
  });
});
