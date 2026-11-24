/** The subagent-profile vocabulary: one Markdown file per profile, YAML frontmatter for the
 * harness, the profile it runs in, model, effort, sections and phases, the body for the initial
 * prompt.
 *
 * A subagent is a harness profile plus a task: the file carries the same fields a harness profile
 * does (`@corvi/agents/harness-profile-fields`), and `basedOnHarnessProfile:` names the profile
 * it is layered on. The overlay merges onto that profile when the subagent is resolved, so a file
 * can adjust one thing — say, its model — without restating the environment. `harness:` names the
 * program, exactly as it does in a harness profile.
 *
 * Parsing is pure and total, exactly like `@corvi/actions/model`: a file is either one well-formed
 * `SubagentProfile` or a list of reasons it is not, and a malformed file is listed with its
 * reasons rather than hidden. Model and effort are checked loosely on purpose — a model catalog
 * changes with the harness, so an unknown id is a runtime concern, never a parse failure. An
 * unknown harness-profile reference is not a parse failure either: discovery is what knows the
 * ids.
 */
import { Result, Schema } from "effect";

import { ChangePhase } from "@corvi/contracts/changes";
import { splitFrontmatter } from "@corvi/markdown/frontmatter";
import { parseHarnessProfileFields, type HarnessProfileFields } from "./harnessProfileFields.ts";

export { splitFrontmatter };

/** The thinking levels pi's `--thinking` takes; opencode's equivalent is mapped from them by the
 * harness adapters. An unknown level is passed through (the harness decides), so this list is
 * the documented vocabulary, not a validation gate. */
export const SUBAGENT_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One configured subagent profile: the harness profile it runs in and the task it starts with. */
export type SubagentProfile = HarnessProfileFields & {
  /** How the page and the menu name it. */
  readonly label: string;
  /** The harness profile this subagent is layered on, by id (`subagents-base`) or key
   * (`global:subagents-base`). Absent means the change's subagent selector, then the settings
   * default. */
  readonly basedOnHarnessProfile?: string;
  /** When the profile is offered; absent means every phase. */
  readonly phases?: readonly ChangePhase[];
  /** The initial prompt, rendered with the action placeholder facts when an instance is
   * created. */
  readonly body: string;
};

/** Why a file is not a profile. Every reason names a field, so a log line is useful. */
export type InvalidSubagentProfileFile = {
  readonly reasons: readonly string[];
};

const invalid = (...reasons: string[]): Result.Result<SubagentProfile, InvalidSubagentProfileFile> =>
  Result.fail({ reasons });

const isPhase = Schema.is(ChangePhase);

/** The harness-profile fields a subagent profile overlays on the one it is based on. The
 * `basedOnHarnessProfile` reference is left out: it selects the profile, it is not part of the
 * environment. */
export const harnessProfileFieldsOf = (profile: SubagentProfile): HarnessProfileFields => ({
  ...(profile.harness === undefined ? {} : { harness: profile.harness }),
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
export const parseSubagentProfileFile = (
  text: string,
): Result.Result<SubagentProfile, InvalidSubagentProfileFile> => {
  const split = splitFrontmatter(text);
  if (!split || typeof split.fields !== "object" || split.fields === null) {
    return invalid("missing or unparseable YAML frontmatter");
  }
  const fields = split.fields as Record<string, unknown>;
  const reasons: string[] = [];

  const rawLabel = fields["label"];
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (!label) reasons.push("label: required, a string");

  const parsed = parseHarnessProfileFields(fields);
  if (Result.isFailure(parsed)) reasons.push(...parsed.failure.reasons);

  // An absent reference is allowed: the change's subagent selector, then the settings default,
  // then answers. A present but empty value is a reason, so an author who wrote
  // `basedOnHarnessProfile: ""` is told why it did not count.
  const rawBasedOn = fields["basedOnHarnessProfile"];
  if (typeof rawBasedOn === "string" && rawBasedOn.trim() === "") {
    reasons.push("basedOnHarnessProfile: a non-empty harness profile id or key");
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
