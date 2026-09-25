/**
 * Read-only accessors for the Foundry runtime shared by the procedure layer.
 * Procedures run inside the elected GM responder's browser, so a handler has
 * full GM authority over the world: the signed agent channel is the trust
 * boundary, not Foundry's own permission model.
 */

/** The active game system id (e.g. "pf2e", "dnd5e", "knight"), or "" if unknown. */
export function systemId(): string {
  const g = globalThis as unknown as { game?: { system?: { id?: string } } };
  return g.game?.system?.id ?? "";
}

/** The active system package version, or "" before system initialization. */
export function systemVersion(): string {
  const g = globalThis as unknown as {
    game?: { system?: { version?: string } };
  };
  return g.game?.system?.version ?? "";
}

/** Foundry's major generation, normalized across the v13/v14 runtime shapes. */
export function foundryGeneration(): number {
  const g = globalThis as unknown as {
    game?: { release?: { generation?: number }; version?: string };
  };
  if (Number.isInteger(g.game?.release?.generation))
    return g.game!.release!.generation!;
  const parsed = Number.parseInt(g.game?.version ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Exact fixture gate for the only Knight actor mapping admitted by this release. */
export function supportsKnightActorUpsertV1Runtime(): boolean {
  return (
    systemId() === "knight" &&
    systemVersion() === "3.58.33" &&
    [13, 14].includes(foundryGeneration())
  );
}

/** The active Foundry world id (`game.world.id`), or "" if unknown. Bound into
 * the module response-signing string (M8) so the agent can pin it and rebuild
 * the canonical bytes. Foundry world ids are `[A-Za-z0-9_-]` — no `|`. */
export function worldId(): string {
  const g = globalThis as unknown as { game?: { world?: { id?: string } } };
  return g.game?.world?.id ?? "";
}
