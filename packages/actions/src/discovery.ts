/** Which actions a change can run, and which file wins a collision — pure, over files already
 * read.
 *
 * Four scopes, more specific first: repository > workspace > global > built-in. A file of the
 * same id in a more specific scope shadows the rest outright; the same id in two repositories is
 * not a collision at all — both are listed, each qualified by its repository's name, because a
 * checkout's actions travel with the checkout. */
import { Result } from "effect";

import type { ActionSource } from "@corvi/contracts/actions";
import { keyOf, mergeScopedFiles } from "@corvi/markdown/scoped";
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

export { keyOf };

/** Parse every file and apply the precedence rules. Order survives: files come in scope order
 * (built-in, global, workspace, repositories) and the menu lists them that way. */
export const mergeActionFiles = (files: readonly ActionFileInput[]): Discovery => {
  const merged = mergeScopedFiles<ActionFileInput, Action>(files, (file) => {
    const parsed = parseActionFile(file.text);
    return Result.isSuccess(parsed) ? { value: parsed.success } : { reasons: parsed.failure.reasons };
  });
  return {
    actions: merged.entries.map(({ key, file, value }) => ({
      key,
      id: file.id,
      source: file.source,
      sourceLabel: file.originLabel ?? file.origin,
      action: value,
    })),
    skipped: merged.skipped,
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
