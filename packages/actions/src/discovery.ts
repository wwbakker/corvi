/** Which actions a change can run, and which file wins a collision — pure, over files already
 * read.
 *
 * Four scopes, more specific first: repository > workspace > global > built-in. A file of the
 * same id in a more specific scope shadows the rest outright; the same id in two repositories is
 * not a collision at all — both are listed, each qualified by its repository's name, because a
 * checkout's actions travel with the checkout. */
import { Either } from "effect";

import type { ActionSource } from "@corvi/contracts/actions";
import { parseActionFile, type Action, type InvalidActionFile } from "./model.ts";

/** One file as discovery reads it: its id is the filename without `.md`. */
export type ActionFileInput = {
  readonly id: string;
  readonly source: ActionSource;
  /** The workspace id or repository name the file came from; part of the key. */
  readonly origin?: string;
  /** How the source is shown beside the label ("orders-api"). */
  readonly originLabel?: string;
  readonly text: string;
};

/** One runnable action and where it came from. */
export type DiscoveredAction = {
  /** Names the file's place, not its text: `repository:orders-api:test`. Running one is naming
   * the key, and the server resolves the file again. */
  readonly key: string;
  readonly id: string;
  readonly source: ActionSource;
  readonly sourceLabel?: string;
  readonly action: Action;
};

export type SkippedActionFile = {
  readonly key: string;
  readonly reasons: readonly string[];
};

export type Discovery = {
  readonly actions: readonly DiscoveredAction[];
  /** Files that did not parse. They are skipped with their reasons and never take the menu
   * down. */
  readonly skipped: readonly SkippedActionFile[];
};

/** The scope ranks, most specific first. Two repositories are equal — both are listed. */
const rank: Record<ActionSource, number> = {
  repository: 3,
  workspace: 2,
  global: 1,
  builtin: 0,
};

/** `repository:orders-api:test`, `workspace:personal:test`, `global:test`, `builtin:brief`. */
export const keyOf = (source: ActionSource, origin: string | undefined, id: string): string =>
  source === "global" || source === "builtin" ? `${source}:${id}` : `${source}:${origin ?? ""}:${id}`;

/** Parse every file and apply the precedence rules. Order survives: files come in scope order
 * (built-in, global, workspace, repositories) and the menu lists them that way. */
export const mergeActionFiles = (files: readonly ActionFileInput[]): Discovery => {
  const actions: DiscoveredAction[] = [];
  const skipped: SkippedActionFile[] = [];
  for (const file of files) {
    const key = keyOf(file.source, file.origin, file.id);
    const parsed = parseActionFile(file.text);
    if (Either.isLeft(parsed)) {
      skipped.push({ key, reasons: parsed.left.reasons });
      continue;
    }
    actions.push({
      key,
      id: file.id,
      source: file.source,
      sourceLabel: file.originLabel ?? file.origin,
      action: parsed.right,
    });
  }

  // Collision by id. A repository action is a different story from the other scopes: the same
  // id in two checkouts is not a collision at all (both are listed, each qualified by its
  // repository), while a repository file hides every less specific one. Outside repository
  // scope the most specific file wins outright.
  const byId = new Map<string, DiscoveredAction[]>();
  for (const found of actions) {
    const same = byId.get(found.id) ?? [];
    same.push(found);
    byId.set(found.id, same);
  }
  const winners = new Set<DiscoveredAction>();
  for (const same of byId.values()) {
    const repositories = same.filter((a) => a.source === "repository");
    if (repositories.length > 0) {
      for (const a of repositories) winners.add(a);
      continue;
    }
    // No repository file: the most specific scope wins outright.
    winners.add(same.reduce((best, a) => (rank[a.source] > rank[best.source] ? a : best)));
  }

  return {
    actions: actions.filter((a) => winners.has(a)),
    skipped,
  };
};

/** The brief's template, behind the one chain the product keeps for compatibility: a `brief.md`
 * that shadows the built-in wins whole, then the legacy `ideationPrompt` setting while it is
 * set, then the shipped body. */
export const resolveBriefTemplate = (input: {
  readonly actions: readonly DiscoveredAction[];
  readonly ideationPrompt: string;
  readonly shippedBody: string;
}): string => {
  // The built-in is not a shadow of itself: without a user file the chain falls through to the
  // legacy setting and then to the shipped body.
  const shadow = input.actions.find((a) => a.id === "brief" && a.source !== "builtin");
  if (shadow) return shadow.action.body;
  return input.ideationPrompt !== "" ? input.ideationPrompt : input.shippedBody;
};
