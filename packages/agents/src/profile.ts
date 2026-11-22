/** The subagent profile vocabulary: one Markdown file per profile, YAML frontmatter for the
 * harness, model, effort, sections and phases, the body for the initial prompt.
 *
 * A subagent is a harness plus a task: the file carries the same harness fields a harness file
 * does (`@corvi/agents/harness-fields`), with `harness:` naming the harness it starts rather than
 * the harness it inherits from. The overlay merges onto the named harness when the subagent is
 * resolved, so a file can adjust one thing — say, its model — without restating the environment.
 *
 * Parsing is pure and total, exactly like `@corvi/actions/model`: a file is either one well-formed
 * `Profile` or a list of reasons it is not, and a malformed file is listed with its reasons
 * rather than hidden. Model and effort are checked loosely on purpose — a model catalog changes
 * with the harness, so an unknown id is a runtime concern, never a parse failure. An unknown
 * harness id is not a parse failure either: discovery is what knows the ids.
 */
import { Result, Schema } from "effect";

import { ChangePhase } from "@corvi/contracts/changes";
import { splitFrontmatter } from "@corvi/markdown/frontmatter";
import { parseHarnessFields, type HarnessFields } from "./harnessFields.ts";

export { splitFrontmatter };

/** The thinking levels pi's `--thinking` takes; opencode's equivalent is mapped from them by the
 * harness adapters. An unknown level is passed through (the harness decides), so this list is
 * the documented vocabulary, not a validation gate. */
export const SUBAGENT_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One configured subagent profile: the harness it runs and the task it starts with. */
export type Profile = Omit<HarnessFields, "harness"> & {
  /** How the page and the menu name it. */
  readonly label: string;
  /** The harness this subagent runs, by id (`pi`, `pi-bare`, `opencode`, or one of the user's).
   * Absent means the change's subagent default (workspace, then global, then `pi`). Resolution
   * walks that harness's own chain and merges this file's fields on top. */
  readonly harness?: string;
  /** When the profile is offered; absent means every phase. */
  readonly phases?: readonly ChangePhase[];
  /** The initial prompt, rendered with the action placeholder facts when an instance is
   * created. */
  readonly body: string;
};

/** Why a file is not a profile. Every reason names a field, so a log line is useful. */
export type InvalidProfileFile = {
  readonly reasons: readonly string[];
};

const invalid = (...reasons: string[]): Result.Result<Profile, InvalidProfileFile> =>
  Result.fail({ reasons });

const isPhase = Schema.is(ChangePhase);

/** The harness fields a profile overlays on the harness it names. `harness` is left out: there
 * it means "which harness to start", not "which harness to inherit". */
export const harnessFieldsOfProfile = (profile: Profile): HarnessFields => ({
  ...(profile.agent === undefined ? {} : { agent: profile.agent }),
  ...(profile.model === undefined ? {} : { model: profile.model }),
  ...(profile.effort === undefined ? {} : { effort: profile.effort }),
  ...(profile.enabledModels === undefined ? {} : { enabledModels: profile.enabledModels }),
  ...(profile.instructions === undefined ? {} : { instructions: profile.instructions }),
  extensions: profile.extensions,
  skills: profile.skills,
  packages: profile.packages,
  mcp: profile.mcp,
});

/** Parse one profile file. Unknown frontmatter keys are tolerated — a file may carry more than
 * this vocabulary uses — but every key it knows is checked. */
export const parseProfileFile = (text: string): Result.Result<Profile, InvalidProfileFile> => {
  const split = splitFrontmatter(text);
  if (!split || typeof split.fields !== "object" || split.fields === null) {
    return invalid("missing or unparseable YAML frontmatter");
  }
  const fields = split.fields as Record<string, unknown>;
  const reasons: string[] = [];

  const rawLabel = fields["label"];
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (!label) reasons.push("label: required, a string");

  const parsed = parseHarnessFields(fields);
  if (Result.isFailure(parsed)) reasons.push(...parsed.failure.reasons);
  // Absent is allowed: the change's subagent default then answers. A present but empty value is
  // a reason from the field parser, which treats an empty string as unset; name it here too so an
  // author who wrote `harness: ""` is told why it did not count.
  const rawHarness = fields["harness"];
  if (typeof rawHarness === "string" && rawHarness.trim() === "") {
    reasons.push("harness: a non-empty harness id");
  }

  const rawPhases = fields["phases"];
  const parsedPhases =
    rawPhases === undefined
      ? undefined
      : Array.isArray(rawPhases) && rawPhases.every(isPhase)
        ? (rawPhases as readonly ChangePhase[])
        : null;
  if (parsedPhases === null) reasons.push("phases: must be a list of the change's phases");
  // An empty list is the same as an absent one: the profile is offered in every phase.
  const phases =
    parsedPhases === undefined || parsedPhases === null || parsedPhases.length === 0
      ? undefined
      : parsedPhases;

  if (reasons.length > 0 || Result.isFailure(parsed)) return invalid(...reasons);

  return Result.succeed({
    ...parsed.success,
    label,
    phases,
    body: split.body,
  });
};
