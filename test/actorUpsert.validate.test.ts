import { afterEach, describe, expect, it, vi } from "vitest";
import { validateKnightActorUpsertV1 } from "../src/procedures/actorUpsert.js";
import { approved } from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

describe("actor.upsert.v1 request validation", () => {
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
