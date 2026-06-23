import type { Procedure } from "../rpc/registry.js";

/**
 * Tier-1 oracle (read): expose a fully-prepared actor's system-aware data over the RPC channel.
 *
 * The headless Go connector only ever sees Foundry *source* data; derived stats (saving-throw
 * totals + proficiency ranks, AC, spell DC/attack, MAP context, slot maxes, applied Active-Effect
 * consequences) are computed by the system's JS and exist ONLY inside a live Foundry session —
 * i.e. here. We return the prepared `actor.system` verbatim PLUS a small normalized `derived`
 * block so the app can render exact numbers without re-implementing the system's modifier engine.
 *
 * Strictly additive enrichment: when this capability is absent the app keeps its own locally
 * derived baseline (standalone-first), so no widget is ever gated by Foundry being online.
 *
 * `sheet.derived({ actorId })` → `{ actorId, name, type, img, system, items, effects, derived }`
 *
 * NOTE: the per-system `derived` extraction is best-effort and pending verification against a real
 * Foundry world per system; the raw prepared `system` block is always returned regardless.
 */

interface ItemLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  img?: string | null;
  system?: Record<string, unknown>;
}
interface EffectLike {
  id?: string | null;
  name?: string | null;
  disabled?: boolean;
  statuses?: Iterable<string> | { has(s: string): boolean };
  changes?: unknown;
}
interface ActorLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  img?: string | null;
  system?: Record<string, unknown>;
  items?: Iterable<ItemLike>;
  effects?: Iterable<EffectLike>;
}
interface ActorsLike {
  get(id: string): ActorLike | undefined;
}

function actors(): ActorsLike {
  const g = globalThis as unknown as { game?: { actors?: ActorsLike } };
  const a = g.game?.actors;
  if (!a) throw new Error("Foundry game.actors is unavailable");
  return a;
}

function systemId(): string {
  const g = globalThis as unknown as { game?: { system?: { id?: string } } };
  return g.game?.system?.id ?? "";
}

/** Safely read a number at a nested path; undefined if any segment is missing or non-numeric. */
function num(obj: unknown, ...path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return typeof cur === "number" ? cur : undefined;
}

function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function pf2eDerived(sys: Record<string, unknown>): Record<string, unknown> {
  const save = (k: string) =>
    defined({ total: num(sys, "saves", k, "value"), rank: num(sys, "saves", k, "rank") });
  return defined({
    ac: num(sys, "attributes", "ac", "value"),
    perception: num(sys, "perception", "mod") ?? num(sys, "attributes", "perception", "value"),
    saves: defined({ fortitude: save("fortitude"), reflex: save("reflex"), will: save("will") }),
  });
}

function dnd5eDerived(sys: Record<string, unknown>): Record<string, unknown> {
  return defined({
    ac: num(sys, "attributes", "ac", "value"),
    proficiency: num(sys, "attributes", "prof"),
    spellcasting: defined({
      dc: num(sys, "attributes", "spelldc") ?? num(sys, "attributes", "spell", "dc"),
      attack: num(sys, "attributes", "spell", "attack"),
    }),
  });
}

function extractDerived(actor: ActorLike): Record<string, unknown> {
  const sys = actor.system ?? {};
  switch (systemId()) {
    case "pf2e":
      return pf2eDerived(sys);
    case "dnd5e":
      return dnd5eDerived(sys);
    default:
      return {};
  }
}

function statuses(effect: EffectLike): string[] {
  const s = effect.statuses;
  if (!s) return [];
  if (Symbol.iterator in (s as object)) return [...(s as Iterable<string>)];
  return [];
}

export const sheetDerived: Procedure = async (payload) => {
  const actorId = String((payload as { actorId?: unknown } | null)?.actorId ?? "").trim();
  if (!actorId) throw new Error("sheet.derived requires 'actorId'");

  const actor = actors().get(actorId);
  if (!actor) throw new Error(`unknown actor ${actorId}`);

  const items = [...(actor.items ?? [])].map((item) => ({
    id: item.id ?? "",
    name: item.name ?? "",
    type: item.type ?? "",
    img: item.img ?? undefined,
    system: item.system ?? {},
  }));
  const effects = [...(actor.effects ?? [])].map((effect) => ({
    id: effect.id ?? "",
    name: effect.name ?? "",
    disabled: effect.disabled ?? false,
    statuses: statuses(effect),
  }));

  return {
    actorId: actor.id ?? actorId,
    name: actor.name ?? "",
    type: actor.type ?? "",
    img: actor.img ?? undefined,
    system: actor.system ?? {}, // prepared system data (derived values live here)
    items,
    effects,
    derived: extractDerived(actor),
  };
};
