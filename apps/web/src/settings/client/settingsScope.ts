import type { WorkspaceDto } from "@corvi/contracts/config";

/**
 * A workspace's settings: the same shape as the top level, overriding it key by key. Writable, so
 * the draft's edits copy-and-drop keys freely.
 */
export type Overrides = {
  -readonly [K in keyof NonNullable<WorkspaceDto["settings"]>]: NonNullable<WorkspaceDto["settings"]>[K];
};

/**
 * The scope on screen, as a section form sees it.
 *
 * A form never resolves the inheritance chain itself: the page builds one of these from the
 * draft and the effective settings, so every section reads a value, inherits one and writes a
 * decision the same way.
 */
export type SettingsScope = {
  /** "global", or the selected workspace's index into the draft's list. */
  readonly at: "global" | number;
  /** This scope's own value for a setting; `undefined` means "not set here". */
  value<K extends keyof Overrides>(key: K): Overrides[K];
  /** What applies when this scope sets nothing: the global value over the effective one. */
  inherited<K extends keyof Overrides>(key: K): Overrides[K];
  /** Write this scope's decision. */
  set<K extends keyof Overrides>(key: K, next: Overrides[K]): void;
  /** Drop this scope's decision and inherit the global one again — a workspace's alone. */
  drop(key: keyof Overrides): void;
  /** The environment variable overriding the setting, when one does. */
  lock(field: string): string | undefined;
};
