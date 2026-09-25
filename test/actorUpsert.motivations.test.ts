import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorUpsertV1,
  type ActorUpsertResultV1,
} from "../src/procedures/actorUpsert.js";
import { MODULE_ID } from "../src/constants.js";
import {
  approved,
  fakeActor,
  setPath,
  stubFoundry,
} from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

describe("actor.upsert.v1 minor motivations", () => {
  it("reconciles the authoritative motivation list using only TC-managed Items", async () => {
    const actor = fakeActor();
    const managed = (id: string, index: number) => {
      const item: Record<string, unknown> = {
        id,
        type: "motivationMineure",
        system: { description: "old" },
        flags: {
          [MODULE_ID]: {
            actorUpsertMinorMotivationV1: { schemaVersion: 1, index },
          },
        },
      };
      item.update = vi.fn(async (changes: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(changes))
          setPath(item, key, value);
      });
      return item;
    };
    const keep = managed("motivation000001", 0);
    actor.items.contents.push(
      keep,
      managed("motivation000002", 0),
      managed("motivation000003", 1),
      managed("motivation000004", 3),
      {
        id: "motivation000005",
        type: "motivationMineure",
        system: { description: "MJ-authored; untouched" },
      },
    );
    stubFoundry([actor]);
    const req = approved({
      assignedActorId: actor.id,
      equipment: undefined,
      profile: {
        ...approved().profile!,
        minorMotivations: ["Respecter le blason"],
      },
    });
    const result = (await actorUpsertV1(
      req,
      {} as never,
    )) as ActorUpsertResultV1;

    expect(result.warnings).toContain("minor_motivation_collision:0");
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", [
      "motivation000002",
      "motivation000003",
      "motivation000004",
    ]);
    expect(keep.system).toEqual({ description: "Respecter le blason" });
    expect(actor.items.contents).toContainEqual(
      expect.objectContaining({
        id: "motivation000005",
        system: { description: "MJ-authored; untouched" },
      }),
    );
  });
});
