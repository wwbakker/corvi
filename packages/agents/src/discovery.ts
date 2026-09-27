/** Which subagent profiles a change can run, and which file wins a collision — pure, over files
 * already read.
 *
 * The same four scopes and precedence as actions: repository > workspace > global > built-in. A
 * file of the same id in a more specific scope shadows the rest outright; the same id in two
 * repositories is not a collision at all — both are listed, each qualified by its repository's
 * name, because a checkout's profiles travel with the checkout. */
import { Either } from "effect";

import type { SubagentSource } from "@corvi/contracts/subagents";
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

/** The scope ranks, most specific first. Two repositories are equal — both are listed. */
const rank: Record<SubagentSource, number> = {
  repository: 3,
  workspace: 2,
  global: 1,
  builtin: 0,
};

/** `repository:orders-api:reviewer`, `workspace:personal:reviewer`, `global:reviewer`,
 * `builtin:reviewer`. */
export const keyOf = (source: SubagentSource, origin: string | undefined, id: string): string =>
  source === "global" || source === "builtin" ? `${source}:${id}` : `${source}:${origin ?? ""}:${id}`;

/** Parse every file and apply the precedence rules. Order survives: files come in scope order
 * (built-in, global, workspace, repositories) and the list keeps it. */
export const mergeProfileFiles = (files: readonly ProfileFileInput[]): ProfileDiscovery => {
  const parsed: { readonly file: ProfileFileInput; readonly key: string; readonly profile: Profile }[] = [];
  const skipped: SkippedProfileFile[] = [];
  for (const file of files) {
    const key = keyOf(file.source, file.origin, file.id);
    if (file.readable === false) {
      skipped.push({ key, reasons: ["cannot read this file"] });
      continue;
    }
    const result = parseProfileFile(file.text);
    if (Either.isLeft(result)) {
      skipped.push({ key, reasons: result.left.reasons });
      continue;
    }
    parsed.push({ file, key, profile: result.right });
  }

  const byId = new Map<string, typeof parsed>();
  for (const found of parsed) {
    const same = byId.get(found.file.id) ?? [];
    same.push(found);
    byId.set(found.file.id, same);
  }
  const winners = new Set<(typeof parsed)[number]>();
  for (const same of byId.values()) {
    const repositories = same.filter((found) => found.file.source === "repository");
    if (repositories.length > 0) {
      for (const found of repositories) winners.add(found);
      continue;
    }
    winners.add(
      same.reduce((best, found) => (rank[found.file.source] > rank[best.file.source] ? found : best)),
    );
  }

  return {
    profiles: parsed
      .filter((found) => winners.has(found))
      .map(
        (found): DiscoveredProfile => ({
          key: found.key,
          id: found.file.id,
          source: found.file.source,
          sourceLabel: found.file.originLabel ?? found.file.origin,
          profile: found.profile,
        }),
      ),
    skipped,
  };
};
