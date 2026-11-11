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

interface UsersLike {
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
  /** Each entry carries its Item's `_id`. */
  updateEmbeddedDocuments?(type: "Item", data: Dict[]): Promise<unknown>;
  /** Embedded ActiveEffects (read by the Fifth Edition lane). */
  effects?: { contents?: ActiveEffectLike[] } | Iterable<ActiveEffectLike>;
  /** Foundry's status toggle (create or delete the status's effect). */
  toggleStatusEffect?(
    statusId: string,
    options: { active: boolean },
  ): Promise<unknown>;
  /** pf2e: raise a valued condition, or create it when absent. */
  increaseCondition?(
    slug: string,
    options: { value: number },
  ): Promise<unknown>;
  /** pf2e's prepared inventory: its currency APIs (`removeCurrency` answers
   * false, writing nothing, when the coins are not there). */
  inventory?: {
    addCurrency?(coins: Record<string, number>): Promise<unknown>;
    removeCurrency?(
      coins: Record<string, number>,
      options: { byValue: boolean },
    ): Promise<boolean>;
  };
}

/** An ActiveEffect embedded in an Actor. */
export interface ActiveEffectLike {
  id?: string;
  _id?: string;
  type?: string;
  system?: unknown;
}

/** `game.actors`: exposes `contents`, is iterable, or both, depending on the
 * Foundry generation. */
export interface ActorsLike {
  contents?: ActorLike[];
  get(id: string): ActorLike | undefined;
  [Symbol.iterator]?(): Iterator<ActorLike>;
}

/** Actor.implementation — the configured Actor document class. */
interface ActorFactoryLike {
  create(data: Dict, options?: Dict): Promise<unknown>;
}

/** A document read from a compendium pack. */
export interface PackDocumentLike {
  id?: string;
  _id?: string;
  toObject(): unknown;
}

/** A compendium pack (`game.packs` entry). */
export interface CompendiumPackLike {
  collection: string;
  metadata: { id?: string; label?: string; type?: string; system?: string };
  /** `fields` adds those (dotted) source paths to each index entry. */
  getIndex(options?: { fields?: string[] }): Promise<Iterable<Dict>>;
  getDocument(id: string): Promise<{ toObject(): unknown } | null | undefined>;
  /** Every document matching `query` (`{ _id__in: [...] }`), in one request. */
  getDocuments(query: Dict): Promise<PackDocumentLike[]>;
  testUserPermission?(user: unknown, permission: string): boolean;
}

export interface CompendiumPacksLike {
  [Symbol.iterator](): Iterator<CompendiumPackLike>;
  get(collection: string): CompendiumPackLike | undefined;
}

/** `game.items`, as far as cloning a compendium document into a source
 * (`fromCompendium` stamps `_stats.compendiumSource`). */
interface ItemsLike {
  fromCompendium?(document: unknown, options?: Dict): Dict;
  get?(id: string):
    | {
        toObject(): unknown;
        testUserPermission?(user: unknown, permission: string): boolean;
      }
    | undefined;
}

interface ModuleLike {
  active?: boolean;
  version?: string;
}

interface ModulesLike {
  get(id: string): ModuleLike | undefined;
}

// fvtt-types models settings only for keys it knows; this module's keys are
// registered in module.ts at init and read structurally here.
interface SettingsLike {
  get(namespace: string, key: string): unknown;
  set(namespace: string, key: string, value: unknown): Promise<unknown>;
  register(namespace: string, key: string, data: unknown): void;
  registerMenu(namespace: string, key: string, data: unknown): void;
}

/** `game.socket`, narrowed to the two methods this module uses. Foundry's
 * server passes the sender's user id as a listener's second argument. Foundry
 * ignores a listener's return value, so a listener that returns a promise must
 * handle its own rejection (the promise is there for callers that await it). */
interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on(
    event: string,
    fn: (raw: unknown, senderId?: unknown) => void | Promise<void>,
  ): void;
}

type NotificationsLike = Partial<
  Record<"info" | "warn" | "error", (message: string) => void>
>;

interface HooksLike {
  on(hook: string, fn: (...args: never[]) => void): number;
  off?(hook: string, id: unknown): void;
}

/** The DialogV2 instance surface this module touches: the stable, documented
 * instance API and its element, robust across Foundry 13/14 point releases. */
export interface DialogInstance {
  element: HTMLElement;
  rendered: boolean;
  render(options: { force: boolean }): Promise<unknown>;
  bringToFront?: () => void;
  close(): Promise<unknown>;
}

type DialogV2Class = (new (options: unknown) => DialogInstance) & {
  /** Resolves true on Yes; false or null on No or a closed window. */
  confirm?(options: unknown): Promise<unknown>;
};

/** `foundry.applications.api.ApplicationV2`, as far as a subclass that only
 * overrides `render` needs it. */
type ApplicationV2Class = new (options?: unknown) => {
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
  turn?: number | null;
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
interface CombatsLike {
  contents?: CombatLike[];
  [Symbol.iterator]?(): Iterator<CombatLike>;
}

/** ChatMessage.implementation — the configured ChatMessage document class. */
interface ChatMessageFactoryLike {
  create(data: Dict, options?: Dict): Promise<unknown>;
}

/** Combat.implementation — the configured Combat document class. */
interface CombatFactoryLike {
  create(data: Dict, options?: Dict): Promise<unknown>;
}

/** The slice of `game` this module reads. */
interface GameLike {
  user?: UserLike;
  users?: UsersLike;
  actors?: ActorsLike;
  combats?: CombatsLike;
  scenes?: { viewed?: SceneLike | null };
  packs?: CompendiumPacksLike;
  items?: ItemsLike;
  modules?: ModulesLike;
  system?: { id?: string; version?: string };
  world?: { id?: string };
  release?: { generation?: number };
  version?: string;
  settings?: SettingsLike;
  socket?: SocketLike;
  /** pf2e's system namespace (the live-counters lane; the check lane's `Check`). */
  pf2e?: { ConditionManager?: Pf2eConditionManagerLike; Check?: unknown };
  /** The Knight system's namespace (its roller, for the attack lane). */
  knight?: { RollKnight?: unknown };
  /** The chat log (`game.messages`). */
  messages?: { contents?: unknown[] };
  i18n?: { localize(key: string): string };
}

/** `game.pf2e.ConditionManager`: set a condition item's value by id (0 deletes). */
export interface Pf2eConditionManagerLike {
  updateConditionValue?(
    itemId: string,
    actor: unknown,
    value: number,
  ): Promise<unknown>;
}

/** Foundry's FilePicker class, as far as saving a file into the user data. */
export interface FilePickerLike {
  /** Resolves the server's response (`path` set on success), `false`,
   * `undefined` or `{}` on a failure (it does not throw). */
  upload(
    source: string,
    path: string,
    file: File,
    body?: object,
    options?: { notify?: boolean },
  ): Promise<unknown>;
  /** Rejects when the directory exists or cannot be created. */
  createDirectory(
    source: string,
    target: string,
    options?: object,
  ): Promise<unknown>;
}

interface FoundryGlobals {
  game?: GameLike;
  /** The rendered canvas; its `tokens` layer is a structural view per caller. */
  canvas?: { tokens?: unknown };
  Actor?: { implementation?: ActorFactoryLike };
  Combat?: { implementation?: CombatFactoryLike };
  ChatMessage?: { implementation?: ChatMessageFactoryLike };
  Hooks?: HooksLike;
  ui?: { notifications?: NotificationsLike };
  foundry?: {
    /** Foundry 14+: update operators (`ForcedDeletion` replaces `-=key`). */
    data?: { operators?: { ForcedDeletion?: new () => unknown } };
    applications?: {
      /** Foundry 13+: `apps.FilePicker`, whose `implementation` is the
       * configured (`CONFIG.ux.FilePicker`) subclass. */
      apps?: {
        FilePicker?: FilePickerLike & { implementation?: FilePickerLike };
      };
      api?: {
        DialogV2?: DialogV2Class;
        ApplicationV2?: ApplicationV2Class;
      };
      handlebars?: {
        renderTemplate?: (path: string, data: object) => Promise<string>;
      };
    };
  };
}

function globals(): FoundryGlobals {
  return globalThis as unknown as FoundryGlobals;
}

/** The update entry that deletes `key` from an object field: Foundry 14's
 * `foundry.data.operators.ForcedDeletion` when the runtime has it, otherwise
 * the `{"-=key": null}` syntax it deprecates (the only form before 14). */
export function deletionEntry(key: string): [string, unknown] {
  const ForcedDeletion = globals().foundry?.data?.operators?.ForcedDeletion;
  return typeof ForcedDeletion !== "undefined"
    ? [key, new ForcedDeletion()]
    : [`-=${key}`, null];
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

export function gameItems(): ItemsLike | undefined {
  return foundryGame()?.items;
}

export function gameModules(): ModulesLike | undefined {
  return foundryGame()?.modules;
}

export function gameSettings(): SettingsLike | undefined {
  return foundryGame()?.settings;
}

/** dnd5e's world setting `rulesVersion` ("modern" for the 2024 rules, its
 * default, or "legacy" for 2014), or "" when it is not registered. */
export function dnd5eRulesVersion(): string {
  try {
    const value = gameSettings()?.get("dnd5e", "rulesVersion");
    return typeof value === "string" ? value : "";
  } catch {
    return ""; // Foundry throws on an unregistered setting
  }
}

export function gameSocket(): SocketLike | undefined {
  return foundryGame()?.socket;
}

export function pf2eConditionManager(): Pf2eConditionManagerLike | undefined {
  return foundryGame()?.pf2e?.ConditionManager;
}

export function gameCombats(): CombatsLike | undefined {
  return foundryGame()?.combats;
}

/** The scene the current user is viewing (`game.scenes.viewed`), or null. */
export function viewedScene(): SceneLike | null {
  return foundryGame()?.scenes?.viewed ?? null;
}

/** `canvas.tokens`, the viewed scene's token layer, or undefined. */
export function canvasTokens(): unknown {
  return globals().canvas?.tokens;
}

/** `Combat.implementation`, the class new Combats are created through. */
export function combatImplementation(): CombatFactoryLike | undefined {
  return globals().Combat?.implementation;
}

/** `ChatMessage.implementation`, the class new chat messages are created through. */
export function chatMessageImplementation():
  ChatMessageFactoryLike | undefined {
  return globals().ChatMessage?.implementation;
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

/** `foundry.applications.handlebars.renderTemplate` (Foundry 13+), or undefined. */
export function renderTemplateFn():
  ((path: string, data: object) => Promise<string>) | undefined {
  return globals().foundry?.applications?.handlebars?.renderTemplate;
}

/** `foundry.applications.api.ApplicationV2`, resolved lazily for the same
 * reason (the `foundry` global exists only once `init` runs). */
export function applicationV2Class(): ApplicationV2Class | undefined {
  return globals().foundry?.applications?.api?.ApplicationV2;
}

/** The configured FilePicker (`foundry.applications.apps.FilePicker
 * .implementation`, Foundry 13 and 14), else the base class, else undefined. */
export function filePickerClass(): FilePickerLike | undefined {
  const FilePicker = globals().foundry?.applications?.apps?.FilePicker;
  return FilePicker?.implementation ?? FilePicker;
}
