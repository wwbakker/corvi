/**
 * The extension-declared setting shapes are domain vocabulary — they cross the core↔extension
 * boundary — so they are defined in `core/domain/settings.ts` and re-exported here for the
 * contract's one import.
 */
export type { ExtensionSetting, WorkspaceSetting } from "../../domain/settings.ts";
