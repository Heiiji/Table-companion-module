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
    expect(keep.system).toEqual({
      description: "<p>Respecter le blason</p>",
    });
    expect(actor.items.contents).toContainEqual(
      expect.objectContaining({
        id: "motivation000005",
        system: { description: "MJ-authored; untouched" },
      }),
    );
  });

  it("escapes app text written into the Knight sheet's HTML fields", async () => {
    const actor = fakeActor();
    stubFoundry([actor]);
    const hostile = `<img src=x onerror="alert(1)">`;
    await actorUpsertV1(
      approved({
        assignedActorId: actor.id,
        equipment: undefined,
        profile: {
          ...approved().profile!,
          description: "<script>alert(1)</script>",
          limitedDescription: "Tom & Jerry &lt;3",
          history: `Line one\n\n${hostile}`,
          age: "<32>",
          minorMotivations: [hostile],
        },
      }),
      {} as never,
    );
    const system = actor.system as Record<string, unknown>;
    expect(system.description).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
    // An entity the player typed stays text: decoding gives back what they wrote.
    expect(system.descriptionLimitee).toBe("<p>Tom &amp; Jerry &amp;lt;3</p>");
    expect(system.histoire).toBe(
      "<p>Line one</p><p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    );
    // A plain-string field is not HTML: written as typed.
    expect(system.age).toBe("<32>");
    const motivation = actor.items.contents.find(
      (item) => item.type === "motivationMineure",
    );
    expect(motivation?.system).toEqual({
      description: "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    });
  });
});
