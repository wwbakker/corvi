import type { ChangeId } from "@corvi/contracts/changes";
import { join } from "node:path";

/** One settings scope's changes root and archive root. A change lives under one pair and travels
 * to that pair's archive when it is done. */
export type RootPair = { readonly root: string; readonly archiveRoot: string };

/** Every directory this change may live in: each pair's active root first — the active copy wins
 * — then each pair's archive. The store, shelves and journal all look in this order. */
export const changeDirs = (roots: readonly RootPair[], changeId: ChangeId): string[] => [
  ...roots.map(({ root }) => join(root, changeId)),
  ...roots.map(({ archiveRoot }) => join(archiveRoot, changeId)),
];
