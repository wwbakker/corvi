/** Which subagent profiles a change can run, and which file wins a collision — pure, over files
 * already read.
 *
 * The same four scopes and precedence as actions: repository > workspace > global > built-in. A
 * file of the same id in a more specific scope shadows the rest outright; the same id in two
 * repositories is not a collision at all — both are listed, each qualified by its repository's
 * name, because a checkout's profiles travel with the checkout. */
import { Result } from "effect";

import type { SubagentSource } from "@corvi/contracts/subagents";
import { keyOf, mergeScopedFiles } from "@corvi/markdown/scoped";
import { parseProfileFile, type Profile, type InvalidProfileFile } from "./profile.ts";

/** One file as discovery reads it: its id is the filename without `.md`. */
export type ProfileFileInput = {
  readonly id: string;
  readonly source: SubagentSource;
  /** The workspace id or repository name the file came from; part of the key. */
  readonly origin?: string;
  /** How the source is shown beside the label ("orders-api"). */
  readonly originLabel?: string;
  readonly text: string;
  /** False when the file could not be read: skipped with that reason rather than hidden. */
  readonly readable?: boolean;
};

/** One runnable profile and where it came from. */
export type DiscoveredProfile = {
  /** Names the file's place, not its text: `repository:orders-api:reviewer`. */
  readonly key: string;
  readonly id: string;
  readonly source: SubagentSource;
  readonly sourceLabel?: string;
  readonly profile: Profile;
};

export type SkippedProfileFile = {
  readonly key: string;
  readonly reasons: readonly string[];
};

export type ProfileDiscovery = {
  readonly profiles: readonly DiscoveredProfile[];
  /** Files that did not parse. They are skipped with their reasons and never hide the rest. */
  readonly skipped: readonly SkippedProfileFile[];
};

export { keyOf };

/** Parse every file and apply the precedence rules. Order survives: files come in scope order
 * (built-in, global, workspace, repositories) and the list keeps it. */
export const mergeProfileFiles = (files: readonly ProfileFileInput[]): ProfileDiscovery => {
  const merged = mergeScopedFiles<ProfileFileInput, Profile>(files, (file) => {
    if (file.readable === false) return { reasons: ["cannot read this file"] };
    const result = parseProfileFile(file.text);
    return Result.isSuccess(result) ? { value: result.success } : { reasons: result.failure.reasons };
  });
  return {
    profiles: merged.entries.map(({ key, file, value }) => ({
      key,
      id: file.id,
      source: file.source,
      sourceLabel: file.originLabel ?? file.origin,
      profile: value,
    })),
    skipped: merged.skipped,
  };
};
