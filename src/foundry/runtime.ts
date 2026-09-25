/**
 * The one gateway to Foundry's runtime globals (`game`, `Actor`, `Hooks`, `ui`,
 * `foundry`) for code that must tolerate their absence.
 *
 * Every accessor reads through `globalThis`, so it is safe to call in a unit
 * test or before Foundry has finished initialising: a missing global reads as
 * `undefined` (or "" / 0 for the scalar accessors) and the CALLER decides
 * whether that is an error — each call site keeps its own error behaviour.
 *
 * The types are structural views of just the members this module uses. They
 * are narrower than the foundry-vtt-types models on purpose, so the procedures
 * compile against every supported Foundry generation without leaking `any`.
 *
 * Procedures run inside the elected GM responder's browser, so a handler has
 * full GM authority over the world: the signed agent channel is the trust
 * boundary, not Foundry's own permission model.
 */

export type Dict = Record<string, unknown>;

/** A Foundry user, as identity and permission decisions read it. */
export interface UserLike {
  id?: string | null;
  name?: string | null;
  isGM?: boolean;
  active?: boolean;
}

export interface UsersLike {
  get(id: string): UserLike | undefined;
}

/** An Item embedded in an Actor. */
export interface ActorItemLike {
  id?: string;
  _id?: string;
  type?: string;
  system?: unknown;
  getFlag?(namespace: string, key: string): unknown;
  flags?: Dict;
  update?(changes: Dict): Promise<unknown>;
}

/** An Actor document, as the provisioning procedures read and write it. */
export interface ActorLike {
  id?: string;
  _id?: string;
  name?: string;
  type?: string;
  flags?: Dict;
  ownership?: Dict;
  system?: unknown;
  items?: { contents?: ActorItemLike[] } | Iterable<ActorItemLike>;
  getFlag?(namespace: string, key: string): unknown;
  update(changes: Dict): Promise<unknown>;
  prepareData?(): void;
  createEmbeddedDocuments?(type: "Item", data: Dict[]): Promise<unknown>;
  deleteEmbeddedDocuments?(type: "Item", ids: string[]): Promise<unknown>;
}

/** `game.actors`: exposes `contents`, is iterable, or both, depending on the
 * Foundry generation. */
export interface ActorsLike {
  contents?: ActorLike[];
  get(id: string): ActorLike | undefined;
  [Symbol.iterator]?(): Iterator<ActorLike>;
}

/** Actor.implementation — the configured Actor document class. */
export interface ActorFactoryLike {
  create(data: Dict, options?: Dict): Promise<unknown>;
}

/** A compendium pack (`game.packs` entry). */
export interface CompendiumPackLike {
  collection: string;
  metadata: { id?: string; label?: string; type?: string; system?: string };
  getIndex(): Promise<Iterable<Dict>>;
  getDocument(id: string): Promise<{ toObject(): unknown } | null | undefined>;
  testUserPermission?(user: unknown, permission: string): boolean;
}

export interface CompendiumPacksLike {
  [Symbol.iterator](): Iterator<CompendiumPackLike>;
  get(collection: string): CompendiumPackLike | undefined;
}

export interface ModuleLike {
  active?: boolean;
  version?: string;
}

export interface ModulesLike {
  get(id: string): ModuleLike | undefined;
}

// fvtt-types models settings only for keys it knows; this module's keys are
// registered in module.ts at init and read structurally here.
export interface SettingsLike {
  get(namespace: string, key: string): unknown;
  set(namespace: string, key: string, value: unknown): Promise<unknown>;
}

/** `game.socket`, narrowed to the two methods this module uses. Foundry's
 * server passes the sender's user id as a listener's second argument. */
export interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, fn: (raw: unknown, senderId?: unknown) => void): void;
}

export type NotificationsLike = Partial<
  Record<"info" | "warn" | "error", (message: string) => void>
>;

export interface HooksLike {
  on(hook: string, fn: () => void): unknown;
}

export type DialogV2Class = new (options: unknown) => unknown;

/** The slice of `game` this module reads. */
export interface GameLike {
  user?: UserLike;
  users?: UsersLike;
  actors?: ActorsLike;
  packs?: CompendiumPacksLike;
  modules?: ModulesLike;
  system?: { id?: string; version?: string };
  world?: { id?: string };
  release?: { generation?: number };
  version?: string;
  settings?: SettingsLike;
  socket?: SocketLike;
}

interface FoundryGlobals {
  game?: GameLike;
  Actor?: { implementation?: ActorFactoryLike };
  Hooks?: HooksLike;
  ui?: { notifications?: NotificationsLike };
  foundry?: { applications?: { api?: { DialogV2?: DialogV2Class } } };
}

function globals(): FoundryGlobals {
  return globalThis as unknown as FoundryGlobals;
}

/** `game`, or undefined outside Foundry. */
export function foundryGame(): GameLike | undefined {
  return globals().game;
}

/** The active game system id (e.g. "pf2e", "dnd5e", "knight"), or "" if unknown. */
export function systemId(): string {
  return foundryGame()?.system?.id ?? "";
}

/** The active system package version, or "" before system initialization. */
export function systemVersion(): string {
  return foundryGame()?.system?.version ?? "";
}

/** Foundry's major generation, normalized across the v13/v14 runtime shapes. */
export function foundryGeneration(): number {
  const game = foundryGame();
  if (Number.isInteger(game?.release?.generation))
    return game!.release!.generation!;
  const parsed = Number.parseInt(game?.version ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The active Foundry world id (`game.world.id`), or "" if unknown. Bound into
 * the module response-signing string so the agent can pin it and rebuild the
 * canonical bytes. Foundry world ids are `[A-Za-z0-9_-]` — no `|`. */
export function worldId(): string {
  return foundryGame()?.world?.id ?? "";
}

export function gameUsers(): UsersLike | undefined {
  return foundryGame()?.users;
}

export function gameActors(): ActorsLike | undefined {
  return foundryGame()?.actors;
}

export function gamePacks(): CompendiumPacksLike | undefined {
  return foundryGame()?.packs;
}

export function gameModules(): ModulesLike | undefined {
  return foundryGame()?.modules;
}

export function gameSettings(): SettingsLike | undefined {
  return foundryGame()?.settings;
}

export function gameSocket(): SocketLike | undefined {
  return foundryGame()?.socket;
}

/** `Actor.implementation`, the class new Actors are created through. */
export function actorImplementation(): ActorFactoryLike | undefined {
  return globals().Actor?.implementation;
}

/** `ui.notifications` (toasts); absent in the test harness. */
export function uiNotifications(): NotificationsLike | undefined {
  return globals().ui?.notifications;
}

/** Foundry's `Hooks` registry. */
export function foundryHooks(): HooksLike | undefined {
  return globals().Hooks;
}

/** `foundry.applications.api.DialogV2`, resolved lazily so a caller is safe
 * when the Application framework is missing (a very old Foundry, a unit test). */
export function dialogV2Class(): DialogV2Class | undefined {
  return globals().foundry?.applications?.api?.DialogV2;
}
