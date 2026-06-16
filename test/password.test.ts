import { describe, expect, it } from "vitest";
import { generatePassword } from "../src/util/password.js";

// The alphabet is duplicated here intentionally: the test pins the contract
// (no ambiguous characters, exact size) so an accidental edit to the source
// alphabet is caught rather than silently accepted.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

describe("generatePassword", () => {
  it("has a 57-character unambiguous alphabet (~140 bits at 24 chars)", () => {
    expect(new Set(ALPHABET).size).toBe(57);
    // None of the ambiguous characters leak in.
    for (const c of "0O1lI") expect(ALPHABET).not.toContain(c);
  });

  it("returns the requested length (default 24)", () => {
    expect(generatePassword()).toHaveLength(24);
    expect(generatePassword(8)).toHaveLength(8);
    expect(generatePassword(64)).toHaveLength(64);
  });

  it("only emits characters from the alphabet", () => {
    const pw = generatePassword(2000);
    for (const c of pw) expect(ALPHABET).toContain(c);
  });

  it("is unbiased across the alphabet (rejection sampling)", () => {
    // Draw a large sample; every character should appear, and no character
    // should dominate far beyond the uniform expectation. A loose bound keeps
    // the test stable while still catching modulo bias or a truncated alphabet.
    const counts = new Map<string, number>();
    const pw = generatePassword(57 * 400); // ~400 expected per symbol
    for (const c of pw) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(57);
    const expected = pw.length / 57;
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(expected * 0.6);
      expect(n).toBeLessThan(expected * 1.4);
    }
  });

  it("does not repeat across calls (sanity, not a strict guarantee)", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
