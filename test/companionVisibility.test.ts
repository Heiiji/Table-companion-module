import { afterEach, describe, expect, it, vi } from "vitest";
import {
  companionVisibility,
  shareUnseenWithCompanion,
} from "../src/setup/companionVisibility.js";
import { fakeActor, stubWorld } from "./support/companionWorld.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    // Neither identity setting is written: a user merely named « Companion »,
    // or flagged as it (a player can flag their own User), is not trusted.
    const impostor = {
      id: "ann",
      name: "Companion",
      getFlag: () => true,
    };
    vi.stubGlobal("game", {
      ...(globalThis as unknown as { game: object }).game,
      users: {
        contents: [impostor],
        get: (id: string) => (id === "ann" ? impostor : undefined),
        find: (fn: (user: typeof impostor) => boolean) => [impostor].find(fn),
      },
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

    await expect(shareUnseenWithCompanion(visibility)).resolves.toBe(2);

    expect(limited.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
    expect(none.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
    for (const untouched of [seen, npc])
      expect(untouched.update).not.toHaveBeenCalled();
    expect(companionVisibility()!.unseen).toEqual([]);
  });

  it("re-reads the world after the confirmation", async () => {
    const raised = fakeActor("raised", { ann: 3 });
    const deleted = fakeActor("deleted", { ann: 3 });
    const disowned = fakeActor("disowned", { bob: 3 });
    const kept = fakeActor("kept", { bob: 3 });
    const actors = [raised, deleted, disowned, kept];
    stubWorld(actors);
    const confirmed = companionVisibility()!;
    expect(confirmed.unseen).toHaveLength(4);

    // While the confirmation is open: the GM makes Companion an owner of one
    // character, deletes another, takes a third from its player, and a new
    // player character appears that the GM was never asked about.
    raised.ownership.comp1 = 3;
    actors.splice(actors.indexOf(deleted), 1);
    disowned.ownership = {};
    const newcomer = fakeActor("newcomer", { ann: 3 });
    actors.push(newcomer);

    await expect(shareUnseenWithCompanion(confirmed)).resolves.toBe(1);

    expect(kept.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
    for (const untouched of [raised, deleted, disowned, newcomer])
      expect(untouched.update).not.toHaveBeenCalled();
    expect(raised.ownership.comp1).toBe(3);
  });

  it("skips an actor whose update fails and shares the rest", async () => {
    const gone = fakeActor("gone", { ann: 3 });
    gone.update.mockRejectedValueOnce(new Error("Actor does not exist"));
    const next = fakeActor("next", { bob: 3 });
    stubWorld([gone, next]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      shareUnseenWithCompanion(companionVisibility()!),
    ).resolves.toBe(1);
    expect(next.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
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
