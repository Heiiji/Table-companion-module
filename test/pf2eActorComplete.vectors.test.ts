import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePf2eActorCompleteV1 } from "../src/procedures/pf2eActorComplete.js";
import { RpcError } from "../src/rpc/errors.js";

// The shared contract vectors for `pf2e.actor.complete.v1`, byte-identical to
// the copy the backend tests against. This module is the reference: the
// vectors pin what it accepts and refuses, the words it throws, and the shape
// of its result. A recorded disagreement pins the module's side of it.

interface Vectors {
  procedure: string;
  cases: Array<{ id: string; expect: "valid" | "invalid"; envelope: unknown }>;
  disagreements: Array<{
    id: string;
    moduleVerdict?: "accept" | "refuse";
    vector?: unknown;
  }>;
  errorWords: Array<{ word: string; thrownByModule: boolean }>;
  result: {
    module: {
      completeness: string[];
      keys: string[];
      warningStems: string[];
      written: string[];
    };
    samples: Array<{
      id: string;
      expect: "valid" | "invalid";
      result: unknown;
    }>;
  };
}

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const file = JSON.parse(
  read("./vectors/pf2e-actor-complete-vectors.json"),
) as Vectors;

function verdict(envelope: unknown): "accept" | "refuse" {
  try {
    validatePf2eActorCompleteV1(envelope);
    return "accept";
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("invalid_args");
    return "refuse";
  }
}

describe("pf2e.actor.complete.v1 shared vectors", () => {
  it("name this procedure", () => {
    expect(file.procedure).toBe("pf2e.actor.complete.v1");
  });

  it.each(file.cases.map((c) => [c.id, c] as const))("case %s", (_id, c) => {
    expect(verdict(c.envelope)).toBe(
      c.expect === "valid" ? "accept" : "refuse",
    );
  });

  const pinned = file.disagreements.filter((d) => d.vector !== undefined);
  it("carry disagreement vectors", () => {
    expect(pinned.length).toBeGreaterThan(0);
  });
  it.each(pinned.map((d) => [d.id, d] as const))(
    "disagreement %s keeps the module's verdict",
    (_id, d) => {
      expect(verdict(d.vector)).toBe(d.moduleVerdict);
    },
  );

  it("throw exactly the error words the vectors list for the module", () => {
    const codes = (source: string): Set<string> =>
      new Set(
        [...source.matchAll(/new RpcError\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
      );
    const shared = read("../src/procedures/upsertShared.ts");
    // The shared helpers the procedure calls, and the words they throw.
    const helper = (name: string): Set<string> => {
      const body = shared.match(
        new RegExp(`export function ${name}\\b[\\s\\S]*?\\n}\\n`),
      );
      expect(body, name).not.toBeNull();
      return codes(body![0]);
    };
    const procedure = read("../src/procedures/pf2eActorComplete.ts");
    const helpers = ["invalid", "assertGMResponder", "actorCollection"];
    for (const name of helpers) expect(procedure).toMatch(`${name}(`);
    const own = new Set([
      ...codes(procedure),
      ...helpers.flatMap((name) => [...helper(name)]),
    ]);
    // A plain error mid-write surfaces as procedure_failed.
    expect(procedure).toMatch("throw new Error(");
    // Words the channel answers for any procedure.
    const channelSource =
      read("../src/rpc/channel.ts") + read("../src/rpc/errors.ts");
    const channel = [
      "procedure_failed",
      "procedure_timeout",
      "unknown_procedure",
      "payload_too_large",
    ];
    for (const word of channel) expect(channelSource).toMatch(`"${word}"`);

    const thrown = file.errorWords.filter((w) => w.thrownByModule);
    expect(new Set(thrown.map((w) => w.word))).toEqual(
      new Set([...own, ...channel]),
    );
    for (const w of file.errorWords.filter((w) => !w.thrownByModule))
      expect(own.has(w.word), w.word).toBe(false);
  });

  // The result this module returns: the three keys, a completeness that is
  // full exactly when every warning is item_present, warnings named by stem
  // over slug-shaped parts (lores are slugged), and counts bounded by the
  // request caps. At most one warning per requested item plus the boost,
  // key-ability and ABC warnings: 580 + 5 + 4 + 4 + 1.
  const shape = file.result.module;
  const caps: Record<string, number> = {
    feats: 64,
    spells: 300,
    equipment: 200,
    lores: 16,
  };
  const MAX_WARNINGS = 594;
  const warning = new RegExp(
    `^(?:${shape.warningStems.join("|")}):[a-z0-9-]+(?::[a-z0-9-]+)?$`,
  );
  function decodes(value: unknown): boolean {
    const r = value as Record<string, unknown>;
    const written = r.written as Record<string, unknown>;
    const warnings = r.warnings as unknown[];
    return (
      JSON.stringify(Object.keys(r).sort()) ===
        JSON.stringify([...shape.keys].sort()) &&
      Array.isArray(warnings) &&
      warnings.length <= MAX_WARNINGS &&
      warnings.every((w) => typeof w === "string" && warning.test(w)) &&
      shape.completeness.includes(r.completeness as string) &&
      (r.completeness === "full") ===
        warnings.every((w) => (w as string).startsWith("item_present:")) &&
      typeof written === "object" &&
      written !== null &&
      JSON.stringify(Object.keys(written).sort()) ===
        JSON.stringify([...shape.written].sort()) &&
      shape.written.every(
        (k) =>
          Number.isSafeInteger(written[k]) &&
          (written[k] as number) >= 0 &&
          (written[k] as number) <= caps[k],
      )
    );
  }
  // Only the backend caps warnings at 580; the module may emit up to 594.
  const moduleAccepts = new Set(["warnings-581"]);
  it.each(file.result.samples.map((s) => [s.id, s] as const))(
    "result sample %s",
    (id, s) => {
      expect(decodes(s.result)).toBe(
        s.expect === "valid" || moduleAccepts.has(id),
      );
    },
  );
});
