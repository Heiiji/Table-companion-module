import { afterEach, describe, expect, it, vi } from "vitest";
import {
  companionVisibility,
  shareUnseenWithCompanion,
} from "../src/setup/companionVisibility.js";
import { fakeActor, stubWorld } from "./support/companionWorld.js";

afterEach(() => vi.unstubAllGlobals());

describe("companionVisibility", () => {
  it("counts the player characters and the ones Companion cannot see", () => {
    const seen = fakeActor("seen", { ann: 3, comp1: 2 });
    const ownedByCompanion = fakeActor("own", { bob: 3, comp1: 3 });
    const unseen = fakeActor("unseen", { bob: 3, comp1: 1 });
    const byDefault = fakeActor("everyone", { default: 3, comp1: 0 });
    const companionOnly = fakeActor("companion-only", { comp1: 3 });
    const npc = fakeActor("npc", { default: 0 });
    const shownNpc = fakeActor("shown-npc", { default: 2 });
    stubWorld([
      seen,
      ownedByCompanion,
      unseen,
      byDefault,
      companionOnly,
      npc,
      shownNpc,
    ]);

    const visibility = companionVisibility()!;

    expect(visibility.companion.id).toBe("comp1");
    expect(visibility.total).toBe(4);
    expect(visibility.unseen.map((actor) => actor.id)).toEqual([
      "unseen",
      "everyone",
    ]);
  });

  it("is null without a Companion user", () => {
    stubWorld([fakeActor("pc", { ann: 3 })]);
    vi.stubGlobal("game", {
      ...(globalThis as unknown as { game: object }).game,
      users: { contents: [], get: () => undefined, find: () => undefined },
      settings: { get: () => "" },
    });
    expect(companionVisibility()).toBeNull();
  });
});

describe("shareUnseenWithCompanion", () => {
  it("raises Companion to Observer on exactly the unseen player characters", async () => {
    const limited = fakeActor("limited", { ann: 3, comp1: 1 });
    const none = fakeActor("none", { bob: 3 });
    const seen = fakeActor("seen", { ann: 3, comp1: 3 });
    const npc = fakeActor("npc", { default: 0 });
    stubWorld([limited, none, seen, npc]);

    const visibility = companionVisibility()!;
    // The GM makes Companion an owner of one character while the confirmation
    // is open: the share must not lower that grant to Observer.
    const raced = fakeActor("raced", { ann: 3 });
    visibility.unseen.push(raced);
    raced.ownership.comp1 = 3;

    await expect(shareUnseenWithCompanion(visibility)).resolves.toBe(2);

    expect(limited.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
    expect(none.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
    for (const untouched of [seen, npc, raced])
      expect(untouched.update).not.toHaveBeenCalled();
    expect(raced.ownership.comp1).toBe(3);
    expect(companionVisibility()!.unseen).toEqual([]);
  });

  it("refuses a user who is not a Gamemaster", async () => {
    const pc = fakeActor("pc", { ann: 3 });
    stubWorld([pc], false);

    const visibility = companionVisibility()!;
    expect(visibility.unseen).toHaveLength(1);
    await expect(shareUnseenWithCompanion(visibility)).rejects.toThrow(
      /Gamemaster/,
    );
    expect(pc.update).not.toHaveBeenCalled();
  });
});
