import { afterEach, describe, expect, it, vi } from "vitest";
import { validateKnightActorUpsertV1 } from "../src/procedures/actorUpsert.js";
import { approved } from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

describe("actor.upsert.v1 request validation", () => {
  it("bounds every current resource to 0-9999, as actor.resources.v1 does", () => {
    const at = (health: number) =>
      validateKnightActorUpsertV1({
        ...approved(),
        resources: { ...approved().resources!, health },
      });
    expect(at(9999).resources?.health).toBe(9999);
    expect(() => at(10_000)).toThrow(
      expect.objectContaining({
        code: "invalid_args",
        message: expect.stringMatching(/resources\.health/),
      }),
    );
  });

  it("rejects unknown secret/derived/max/ownership fields at every request boundary", () => {
    for (const extra of [
      { secretTarot: "Le Pendu" },
      { defense: 12 },
      { max: 99 },
      { ownership: { default: 3 } },
      { system: { anything: true } },
    ]) {
      expect(() =>
        validateKnightActorUpsertV1({ ...approved(), ...extra }),
      ).toThrow(/not allowed/);
    }
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        aspects: { ...approved().aspects!, value: 99 },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        characterCreation: {
          ...approved().characterCreation!,
          publicMetadata: {
            ...approved().characterCreation!.publicMetadata,
            heroTarot: {
              ...approved().characterCreation!.publicMetadata.heroTarot,
              secretPast: "Amnésique — secret MJ",
            },
          },
        },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        equipment: { catalogIds: ["knight.weapon.pistolet-de-service"] },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        equipment: {
          selections: [
            {
              catalogId: "knight.module.griffes-de-combat.l1",
              quantity: 1,
              slotAlternativeId: "bras_droit=1+bras_gauche=1",
            },
          ],
        },
      }),
    ).toThrow(/canonical slot allocation/);
  });
});

describe("validateKnightActorUpsertV1 base", () => {
  it("accepts base.name and refuses any other base key or a blank name", () => {
    expect(
      validateKnightActorUpsertV1(approved({ base: { name: "Old" } })).base,
    ).toEqual({ name: "Old" });
    expect(() =>
      validateKnightActorUpsertV1(approved({ base: { profile: {} } as never })),
    ).toThrow("base.profile");
    expect(() =>
      validateKnightActorUpsertV1(approved({ base: { name: " " } })),
    ).toThrow("base.name");
  });
});
