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
  contents?: UserLike[];
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
  /** Foundry's own permission test (ownership, `default`, GM role). */
  testUserPermission?(
    user: UserLike,
    permission: "OBSERVER" | "OWNER",
  ): boolean;
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
 * server passes the sender's user id as a listener's second argument. Foundry
 * ignores a listener's return value, so a listener that returns a promise must
 * handle its own rejection (the promise is there for callers that await it). */
export interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on(
    event: string,
    fn: (raw: unknown, senderId?: unknown) => void | Promise<void>,
  ): void;
}

export type NotificationsLike = Partial<
  Record<"info" | "warn" | "error", (message: string) => void>
>;

export interface HooksLike {
  on(hook: string, fn: () => void): unknown;
}

export type DialogV2Class = (new (options: unknown) => unknown) & {
  /** Resolves true on Yes; false or null on No or a closed window. */
  confirm?(options: unknown): Promise<unknown>;
};

/** `foundry.applications.api.ApplicationV2`, as far as a subclass that only
 * overrides `render` needs it. */
export type ApplicationV2Class = new (options?: unknown) => {
  render(options?: unknown): unknown;
};

/** A Combatant embedded in a Combat, as the combat mirror reads it. */
export interface CombatantLike {
  id?: string;
  _id?: string;
  flags?: Dict;
  getFlag?(namespace: string, key: string): unknown;
}

/** A Combat document, as the combat mirror reads and writes it. */
export interface CombatLike {
  id?: string;
  _id?: string;
  flags?: Dict;
  scene?: SceneLike | null;
  combatants?: { contents?: CombatantLike[] } | Iterable<CombatantLike>;
  turns?: CombatantLike[];
  getFlag?(namespace: string, key: string): unknown;
  setupTurns?(): CombatantLike[];
  update(changes: Dict, options?: Dict): Promise<unknown>;
  delete(): Promise<unknown>;
  createEmbeddedDocuments(type: "Combatant", data: Dict[]): Promise<unknown>;
  updateEmbeddedDocuments(type: "Combatant", data: Dict[]): Promise<unknown>;
  deleteEmbeddedDocuments(type: "Combatant", ids: string[]): Promise<unknown>;
}

/** A token placed on a scene. */
export interface TokenLike {
  id?: string;
  _id?: string;
  actorId?: string | null;
}

/** A Scene, as far as finding an actor's token on it. */
export interface SceneLike {
  id?: string;
  _id?: string;
  tokens?: { contents?: TokenLike[] } | Iterable<TokenLike>;
}

/** `game.combats`: exposes `contents`, is iterable, or both. */
export interface CombatsLike {
  contents?: CombatLike[];
  [Symbol.iterator]?(): Iterator<CombatLike>;
}

/** Combat.implementation — the configured Combat document class. */
export interface CombatFactoryLike {
  create(data: Dict, options?: Dict): Promise<unknown>;
}

/** The slice of `game` this module reads. */
export interface GameLike {
  user?: UserLike;
  users?: UsersLike;
  actors?: ActorsLike;
  combats?: CombatsLike;
  scenes?: { viewed?: SceneLike | null };
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
  Combat?: { implementation?: CombatFactoryLike };
  Hooks?: HooksLike;
  ui?: { notifications?: NotificationsLike };
  foundry?: {
    applications?: {
      api?: {
        DialogV2?: DialogV2Class;
        ApplicationV2?: ApplicationV2Class;
      };
    };
  };
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

export function gameCombats(): CombatsLike | undefined {
  return foundryGame()?.combats;
}

/** The scene the current user is viewing (`game.scenes.viewed`), or null. */
export function viewedScene(): SceneLike | null {
  return foundryGame()?.scenes?.viewed ?? null;
}

/** `Combat.implementation`, the class new Combats are created through. */
export function combatImplementation(): CombatFactoryLike | undefined {
  return globals().Combat?.implementation;
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

/** `foundry.applications.api.ApplicationV2`, resolved lazily for the same
 * reason (the `foundry` global exists only once `init` runs). */
export function applicationV2Class(): ApplicationV2Class | undefined {
  return globals().foundry?.applications?.api?.ApplicationV2;
}
