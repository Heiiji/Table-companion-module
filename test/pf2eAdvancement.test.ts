import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import {
  clearPF2eAdvancementJournal,
  isPF2eAdvancementRuntimeSupported,
  pf2eAdvancementApply,
  pf2eAdvancementPreview,
  pf2eOperationStatus,
} from "../src/procedures/pf2eAdvancement.js";
import { RpcError } from "../src/rpc/errors.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { hasAuthenticatedModuleResponses } from "../src/rpc/trust.js";

const OPERATION_ID = "11111111-1111-1111-1111-111111111111";
const CHARACTER_ID = "22222222-2222-2222-2222-222222222222";

interface FakeActor {
  id: string;
  name: string;
  type: string;
  system: {
    details: { level: { value: number }; xp: { value: number; max: number } };
    attributes: { hp: { value: number; max: number } };
  };
  items: Array<{ id: string; type: string }>;
  flags: Record<string, Record<string, unknown>>;
  _stats: { modifiedTime: number };
  getFlag(scope: string, key: string): unknown;
  update: ReturnType<typeof vi.fn>;
  testUserPermission?: ReturnType<typeof vi.fn>;
}

function makeActor(
  options: {
    level?: number;
    xp?: number;
    threshold?: number;
    update?: (
      patch: Record<string, unknown>,
      actor: FakeActor,
    ) => Promise<void>;
    permission?: boolean;
  } = {},
): FakeActor {
  const actor = {
    id: "foundryActor1",
    name: "Merisiel",
    type: "character",
    system: {
      details: {
        level: { value: options.level ?? 4 },
        xp: { value: options.xp ?? 1_250, max: options.threshold ?? 1_000 },
      },
      attributes: { hp: { value: 31, max: 40 } },
    },
    items: [{ id: "class-rogue", type: "class" }],
    flags: { "table-companion": {} },
    _stats: { modifiedTime: 100 },
    getFlag(scope: string, key: string) {
      return this.flags[scope]?.[key];
    },
    update: vi.fn(),
  } as FakeActor;

  if (options.permission !== undefined) {
    actor.testUserPermission = vi.fn(() => options.permission);
  }
  actor.update = vi.fn(async (patch: Record<string, unknown>) => {
    if (options.update) {
      await options.update(patch, actor);
      return;
    }
    const nextLevel = patch["system.details.level.value"];
    const nextXP = patch["system.details.xp.value"];
    const markers = patch["flags.table-companion.pf2eAdvancementOperations"];
    if (typeof nextLevel === "number")
      actor.system.details.level.value = nextLevel;
    if (typeof nextXP === "number") actor.system.details.xp.value = nextXP;
    actor.flags["table-companion"]!.pf2eAdvancementOperations = markers;

    // Simulate PF2e's live level hook: maximum/current HP rise together and a
    // class feature Item is granted. The procedure must observe, not fabricate,
    // these side effects.
    actor.system.attributes.hp.max += 8;
    actor.system.attributes.hp.value += 8;
    actor.items.push({ id: `class-feature-${nextLevel}`, type: "feat" });
    actor._stats.modifiedTime += 1;
  });
  return actor;
}

function stubRuntime(
  actor: FakeActor,
  options: { systemID?: string; systemVersion?: string; foundry?: string } = {},
) {
  const companion = { id: "companion", name: "Companion", getFlag: () => true };
  vi.stubGlobal("game", {
    version: options.foundry ?? "14.364",
    system: {
      id: options.systemID ?? "pf2e",
      version: options.systemVersion ?? "8.3.0",
    },
    actors: { get: (id: string) => (id === actor.id ? actor : undefined) },
    users: [companion],
  });
}

function previewPayload(overrides: Record<string, unknown> = {}) {
  return {
    actorId: "foundryActor1",
    targetLevel: 5,
    expectedPackRevision: 5,
    advancementMode: "experience",
    ...overrides,
  };
}

function applyPayload(overrides: Record<string, unknown> = {}) {
  return {
    actorId: "foundryActor1",
    expectedActorRevision: "100",
    advancementMode: "experience",
    transaction: {
      operationID: OPERATION_ID,
      characterID: CHARACTER_ID,
      expectedSourceLevel: 4,
      targetLevel: 5,
      expectedPackRevision: 5,
      decisions: [],
      gmOverrideReason: null,
    },
    ...overrides,
  };
}

afterEach(() => {
  clearPF2eAdvancementJournal();
  vi.unstubAllGlobals();
});

describe("PF2e advancement capability gate", () => {
  it("advertises preview but keeps consequential procedures dormant without authenticated replies", () => {
    const actor = makeActor();
    stubRuntime(actor);
    expect(isPF2eAdvancementRuntimeSupported()).toBe(true);
    expect(hasAuthenticatedModuleResponses()).toBe(false);
    const supported = new ProcedureRegistry();
    registerBuiltinProcedures(supported);
    expect(supported.capabilities()).toContain("pf2e.advancement.preview");
    expect(supported.capabilities()).not.toContain("pf2e.advancement.apply");
    expect(supported.capabilities()).not.toContain("pf2e.operation.status");
    expect(supported.get("pf2e.advancement.apply")).toBeUndefined();
    expect(supported.get("pf2e.operation.status")).toBeUndefined();

    stubRuntime(actor, { systemVersion: "8.3.1" });
    expect(isPF2eAdvancementRuntimeSupported()).toBe(false);
    const unsupported = new ProcedureRegistry();
    registerBuiltinProcedures(unsupported);
    expect(unsupported.capabilities()).not.toContain("pf2e.advancement.apply");

    stubRuntime(actor, { foundry: "14.360" });
    expect(isPF2eAdvancementRuntimeSupported()).toBe(false);
    stubRuntime(actor, { foundry: "14.361" });
    expect(isPF2eAdvancementRuntimeSupported()).toBe(true);
    stubRuntime(actor, { foundry: "15.361" });
    expect(isPF2eAdvancementRuntimeSupported()).toBe(false);
    stubRuntime(actor, { foundry: "14.361beta" });
    expect(isPF2eAdvancementRuntimeSupported()).toBe(false);
    stubRuntime(actor, { systemID: "dnd5e" });
    expect(isPF2eAdvancementRuntimeSupported()).toBe(false);
  });

  it("fails closed when a stale caller invokes a handler on another runtime", async () => {
    const actor = makeActor();
    stubRuntime(actor, { foundry: "13.351" });
    await expect(
      pf2eAdvancementPreview(previewPayload(), {} as never),
    ).rejects.toMatchObject({
      code: "unsupported_runtime",
    });
  });
});

describe("pf2e.advancement.preview", () => {
  it("returns readiness, XP carry, revision, and PF2e-owned automatic work", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const result = (await pf2eAdvancementPreview(
      previewPayload(),
      {} as never,
    )) as {
      actor: {
        actorRevision: string;
        currentLevel: number;
        targetLevel: number;
      };
      xp: { current: number; threshold: number; after: number; ready: boolean };
      hp: { policy: string };
      automation: {
        mutation: string;
        systemManaged: string[];
        classAndChoiceCompletion: string;
      };
      blockers: unknown[];
    };
    expect(result.actor).toMatchObject({
      actorRevision: "100",
      currentLevel: 4,
      targetLevel: 5,
    });
    expect(result.xp).toEqual({
      current: 1_250,
      threshold: 1_000,
      after: 250,
      ready: true,
      deducted: 1_000,
    });
    expect(result.hp.policy).toBe("pf2eLevelHookPreservesDamageDeficit");
    expect(result.automation.mutation).toBe("Actor.update");
    expect(result.automation.systemManaged).toContain("classFeatures");
    expect(result.automation.classAndChoiceCompletion).toBe(
      "notClaimedUntilFixtureProven",
    );
    expect(result.blockers).toEqual([]);
  });

  it("reports XP, milestone, cap, and pack blockers without mutating", async () => {
    const actor = makeActor({ level: 20, xp: 20 });
    stubRuntime(actor);
    const result = (await pf2eAdvancementPreview(
      previewPayload({ targetLevel: 21, expectedPackRevision: 4 }),
      {} as never,
    )) as { blockers: Array<{ code: string }> };
    expect(result.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        "pack_revision_mismatch",
        "maximum_level",
        "experience_not_ready",
      ]),
    );
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("rejects unknown top-level fields", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    await expect(
      pf2eAdvancementPreview(
        previewPayload({ arbitraryPath: "system.foo" }),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("requires explicit pack revision and advancement mode", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const withoutPack: Record<string, unknown> = { ...previewPayload() };
    const withoutMode: Record<string, unknown> = { ...previewPayload() };
    delete withoutPack.expectedPackRevision;
    delete withoutMode.advancementMode;

    await expect(
      pf2eAdvancementPreview(withoutPack, {} as never),
    ).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(
      pf2eAdvancementPreview(withoutMode, {} as never),
    ).rejects.toMatchObject({
      code: "invalid_args",
    });
  });

  it("rejects a blank GM override reason when the optional field is supplied", async () => {
    const actor = makeActor();
    stubRuntime(actor);

    await expect(
      pf2eAdvancementPreview(
        previewPayload({ gmOverrideReason: " \t\n " }),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("blocks an actor whose embedded Item identities cannot be verified", async () => {
    const actor = makeActor();
    actor.items.push({ id: "class-rogue", type: "feat" });
    stubRuntime(actor);
    const result = (await pf2eAdvancementPreview(
      previewPayload(),
      {} as never,
    )) as { blockers: Array<{ code: string }> };
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "item_identity_invalid",
    );
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("requires Companion OBSERVER permission", async () => {
    const actor = makeActor({ permission: false });
    stubRuntime(actor);
    await expect(
      pf2eAdvancementPreview(previewPayload(), {} as never),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("pf2e.advancement.apply", () => {
  it("uses one exact Actor.update, verifies PF2e side effects, and replays idempotently", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const first = (await pf2eAdvancementApply(applyPayload(), {} as never)) as {
      outcome: string;
      observed: {
        level: number;
        xpCurrent: number;
        hpCurrent: number;
        hpMaximum: number;
        itemChanges: { added: string[] };
      };
    };

    expect(first.outcome).toBe("accepted");
    expect(first.observed).toMatchObject({
      level: 5,
      xpCurrent: 250,
      hpCurrent: 39,
      hpMaximum: 48,
    });
    expect(first.observed.itemChanges.added).toEqual(["class-feature-5"]);
    expect(actor.update).toHaveBeenCalledOnce();
    const patch = actor.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual([
      "flags.table-companion.pf2eAdvancementOperations",
      "system.details.level.value",
      "system.details.xp.value",
    ]);
    expect(patch["system.details.level.value"]).toBe(5);
    expect(patch["system.details.xp.value"]).toBe(250);

    const replay = (await pf2eAdvancementApply(
      applyPayload(),
      {} as never,
    )) as {
      outcome: string;
    };
    expect(replay.outcome).toBe("accepted");
    expect(actor.update).toHaveBeenCalledOnce();

    clearPF2eAdvancementJournal();
    const recoveredReplay = (await pf2eAdvancementApply(
      applyPayload(),
      {} as never,
    )) as {
      outcome: string;
    };
    expect(recoveredReplay.outcome).toBe("accepted");
    expect(actor.update).toHaveBeenCalledOnce();
  });

  it("re-checks OWNER permission before returning an idempotent receipt", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    await pf2eAdvancementApply(applyPayload(), {} as never);
    actor.testUserPermission = vi.fn(() => false);

    await expect(
      pf2eAdvancementApply(applyPayload(), {} as never),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(actor.update).toHaveBeenCalledOnce();
  });

  it("rejects stale actor revisions before any mutation", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const result = (await pf2eAdvancementApply(
      applyPayload({ expectedActorRevision: "99" }),
      {} as never,
    )) as { outcome: string; code: string };
    expect(result).toMatchObject({
      outcome: "rejected",
      code: "stale_actor_revision",
    });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("requires explicit apply mode and transaction pack revision", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const withoutMode: Record<string, unknown> = { ...applyPayload() };
    delete withoutMode.advancementMode;
    await expect(
      pf2eAdvancementApply(withoutMode, {} as never),
    ).rejects.toMatchObject({
      code: "invalid_args",
    });

    const missingPack = applyPayload() as ReturnType<typeof applyPayload> & {
      transaction: Record<string, unknown>;
    };
    missingPack.transaction = {
      ...(missingPack.transaction as Record<string, unknown>),
    };
    delete missingPack.transaction.expectedPackRevision;
    await expect(
      pf2eAdvancementApply(missingPack, {} as never),
    ).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("validates but rejects typed build decisions until exact PF2e APIs are pinned", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const payload = applyPayload() as ReturnType<typeof applyPayload> & {
      transaction: Record<string, unknown>;
    };
    payload.transaction = {
      ...(payload.transaction as Record<string, unknown>),
      decisions: [
        {
          slotID: "attribute-5-1",
          kind: "attributeBoost",
          selectionID: "strength",
        },
      ],
    };
    const result = (await pf2eAdvancementApply(payload, {} as never)) as {
      outcome: string;
      code: string;
    };
    expect(result).toMatchObject({
      outcome: "rejected",
      code: "unsupported_decisions",
    });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("rejects a client-supplied milestone readiness boolean without verified GM authority", async () => {
    const actor = makeActor({ xp: 100 });
    stubRuntime(actor);
    const result = (await pf2eAdvancementApply(
      applyPayload({ advancementMode: "milestone", milestoneReady: true }),
      {} as never,
    )) as { outcome: string; code: string };
    expect(result).toMatchObject({
      outcome: "rejected",
      code: "milestone_authority_unavailable",
    });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("accepts an exact 500-byte GM override and rejects it without verified GM authority", async () => {
    const actor = makeActor({ xp: 100 });
    stubRuntime(actor);
    const payload = applyPayload() as ReturnType<typeof applyPayload> & {
      transaction: Record<string, unknown>;
    };
    payload.transaction = {
      ...(payload.transaction as Record<string, unknown>),
      gmOverrideReason: "é".repeat(250),
    };
    const result = (await pf2eAdvancementApply(payload, {} as never)) as {
      outcome: string;
      code: string;
    };
    expect(result).toMatchObject({
      outcome: "rejected",
      code: "gm_override_authority_unavailable",
    });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("rejects blank and over-500-byte GM override reasons", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const withReason = (gmOverrideReason: string) => {
      const payload = applyPayload() as ReturnType<typeof applyPayload> & {
        transaction: Record<string, unknown>;
      };
      payload.transaction = {
        ...(payload.transaction as Record<string, unknown>),
        gmOverrideReason,
      };
      return payload;
    };

    await expect(
      pf2eAdvancementApply(withReason("  \t\n"), {} as never),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      pf2eAdvancementApply(withReason(`${"é".repeat(250)}a`), {} as never),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("caps request bytes, including multi-byte selections", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const payload = applyPayload() as ReturnType<typeof applyPayload> & {
      transaction: Record<string, unknown>;
    };
    payload.transaction = {
      ...(payload.transaction as Record<string, unknown>),
      decisions: Array.from({ length: 64 }, (_, index) => ({
        slotID: `slot-${index}`,
        kind: "feat",
        selectionID: "界".repeat(256),
      })),
    };
    await expect(
      pf2eAdvancementApply(payload, {} as never),
    ).rejects.toMatchObject({
      code: "payload_too_large",
    });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("bounds decision count and individual selection strings", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const withDecisions = (decisions: unknown[]) => {
      const payload = applyPayload() as ReturnType<typeof applyPayload> & {
        transaction: Record<string, unknown>;
      };
      payload.transaction = {
        ...(payload.transaction as Record<string, unknown>),
        decisions,
      };
      return payload;
    };

    await expect(
      pf2eAdvancementApply(
        withDecisions(
          Array.from({ length: 65 }, (_, index) => ({
            slotID: `slot-${index}`,
            kind: "feat",
            selectionID: "feat:test",
          })),
        ),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });

    await expect(
      pf2eAdvancementApply(
        withDecisions([
          { slotID: "slot-1", kind: "feat", selectionID: "x".repeat(257) },
        ]),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("enforces decision slot and selection limits in UTF-8 bytes", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    const withDecision = (slotID: string, selectionID: string) => {
      const payload = applyPayload() as ReturnType<typeof applyPayload> & {
        transaction: Record<string, unknown>;
      };
      payload.transaction = {
        ...(payload.transaction as Record<string, unknown>),
        decisions: [{ slotID, kind: "feat", selectionID }],
      };
      return payload;
    };
    const exactSlot = "é".repeat(80);
    const exactSelection = "é".repeat(128);

    const exact = (await pf2eAdvancementApply(
      withDecision(exactSlot, exactSelection),
      {} as never,
    )) as { outcome: string; code: string };
    expect(exact).toMatchObject({
      outcome: "rejected",
      code: "unsupported_decisions",
    });
    await expect(
      pf2eAdvancementApply(
        withDecision(`${exactSlot}a`, "feat:test"),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      pf2eAdvancementApply(
        withDecision("slot-1", `${exactSelection}a`),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("returns needsReview when Actor.update reports an error after state changed", async () => {
    const actor = makeActor({
      update: async (patch, current) => {
        current.system.details.level.value = patch[
          "system.details.level.value"
        ] as number;
        current.flags["table-companion"]!.pf2eAdvancementOperations =
          patch["flags.table-companion.pf2eAdvancementOperations"];
        throw new Error("simulated hook failure");
      },
    });
    stubRuntime(actor);
    const result = (await pf2eAdvancementApply(
      applyPayload(),
      {} as never,
    )) as {
      outcome: string;
      code: string;
    };
    expect(result).toMatchObject({
      outcome: "needsReview",
      code: "actor_update_partial",
    });
  });

  it("treats HP/item/revision-only changes after an update error as partial", async () => {
    const actor = makeActor({
      update: async (_patch, current) => {
        current.system.attributes.hp.max += 8;
        current.items.push({ id: "unexpected-feature", type: "feat" });
        current._stats.modifiedTime += 1;
        throw new Error("simulated side-effect failure");
      },
    });
    stubRuntime(actor);
    const result = (await pf2eAdvancementApply(
      applyPayload(),
      {} as never,
    )) as {
      outcome: string;
      code: string;
    };
    expect(result).toMatchObject({
      outcome: "needsReview",
      code: "actor_update_partial",
    });
  });

  it("requires every refetched embedded Item to have a unique identity", async () => {
    const actor = makeActor({
      update: async (patch, current) => {
        current.system.details.level.value = patch[
          "system.details.level.value"
        ] as number;
        current.system.details.xp.value = patch[
          "system.details.xp.value"
        ] as number;
        current.flags["table-companion"]!.pf2eAdvancementOperations =
          patch["flags.table-companion.pf2eAdvancementOperations"];
        current.items.push({ id: "class-rogue", type: "feat" });
        current._stats.modifiedTime += 1;
      },
    });
    stubRuntime(actor);
    const result = (await pf2eAdvancementApply(
      applyPayload(),
      {} as never,
    )) as {
      outcome: string;
      code: string;
    };
    expect(result).toMatchObject({
      outcome: "needsReview",
      code: "verification_mismatch",
    });
  });

  it("verifies that the live PF2e update preserved the HP damage deficit", async () => {
    const actor = makeActor({
      update: async (patch, current) => {
        current.system.details.level.value = patch[
          "system.details.level.value"
        ] as number;
        current.system.details.xp.value = patch[
          "system.details.xp.value"
        ] as number;
        current.flags["table-companion"]!.pf2eAdvancementOperations =
          patch["flags.table-companion.pf2eAdvancementOperations"];
        current.system.attributes.hp.max += 8;
        current._stats.modifiedTime += 1;
      },
    });
    stubRuntime(actor);
    const result = (await pf2eAdvancementApply(
      applyPayload(),
      {} as never,
    )) as {
      outcome: string;
      code: string;
    };
    expect(result).toMatchObject({
      outcome: "needsReview",
      code: "verification_mismatch",
    });
  });

  it("requires Companion OWNER permission", async () => {
    const actor = makeActor({ permission: false });
    stubRuntime(actor);
    try {
      await pf2eAdvancementApply(applyPayload(), {} as never);
      throw new Error("should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("permission_denied");
    }
  });
});

describe("pf2e.operation.status", () => {
  it("reconciles a known operation and reports unknown after journal/marker loss", async () => {
    const actor = makeActor();
    stubRuntime(actor);
    await pf2eAdvancementApply(applyPayload(), {} as never);
    const known = (await pf2eOperationStatus(
      { actorId: actor.id, operationID: OPERATION_ID },
      {} as never,
    )) as { outcome: string };
    expect(known.outcome).toBe("accepted");

    // A responder reload loses the bounded in-memory journal, but the equally
    // bounded namespaced Actor ledger still prevents replay and reconciles the
    // most recent operations.
    clearPF2eAdvancementJournal();
    const recovered = (await pf2eOperationStatus(
      { actorId: actor.id, operationID: OPERATION_ID },
      {} as never,
    )) as { outcome: string };
    expect(recovered.outcome).toBe("accepted");

    const unknown = (await pf2eOperationStatus(
      {
        actorId: actor.id,
        operationID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      },
      {} as never,
    )) as { outcome: string; retryable: boolean };
    expect(unknown).toMatchObject({
      outcome: "outcomeUnknown",
      retryable: false,
    });
  });
});
