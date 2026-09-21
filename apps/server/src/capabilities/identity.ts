/**
 * The product's own name, in one place.
 *
 * Every path, variable, socket and bundle name that spells "corvi" derives it from here, so the
 * next rename is one file rather than a search across the tree. The directories are the XDG
 * ones the app has always used: configuration beside the other applications' under
 * `~/.config/corvi`, throwaway answers under `~/.cache/corvi`, runtime state under
 * `$XDG_STATE_HOME/corvi` (`~/.local/state/corvi`), and the installed application's own files
 * under `$XDG_DATA_HOME/corvi` (`~/.local/share/corvi`).
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** The name as people read it, in titles and dialogs. */
export const PRODUCT = "Corvi";
/** The name as paths, variables, sockets and bundle ids spell it. */
export const ID = "corvi";
/** Every environment variable of ours begins here: `ENV_PREFIX + "CONFIG"`. */
export const ENV_PREFIX = "CORVI_";
/** One environment variable of ours by its suffix. */
export const env = (suffix: string): string => `${ENV_PREFIX}${suffix}`;

/** Where the config file lives — and, beside it, the fallback extensions directory. */
export const configDir = (): string => join(homedir(), ".config", ID);
/** Where the stale-while-revalidate cache keeps its persisted state. */
export const cacheDir = (): string => join(homedir(), ".cache", ID);
/** Where writable runtime state lives: built chunks and pages, logs, pid files. */
export const stateDir = (): string =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), ID);
/** Where an installed application's own files go. */
export const dataDir = (): string =>
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), ID);

/** One directory per change, under the product's own home by default. */
export const defaultChangesRoot = (): string => join(homedir(), ID, "changes");
/** Completed changes: a setting of its own, not a child of the changes root. */
export const defaultArchiveRoot = (): string => join(homedir(), ID, "changes-archive");
