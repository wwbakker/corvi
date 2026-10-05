/** The subagent profile vocabulary: one Markdown file per profile, YAML frontmatter for the
 * harness, model, effort and phases, the body for the initial prompt.
 *
 * Parsing is pure and total, exactly like `@corvi/actions/model`: a file is either one well-formed
 * `Profile` or a list of reasons it is not, and a malformed file is listed with its reasons
 * rather than hidden. Model and effort are checked loosely on purpose — a model catalog changes
 * with the harness, so an unknown id is a runtime concern, never a parse failure. */
import { Result, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import { ChangePhase } from "@corvi/contracts/changes";
import { SubagentHarness } from "@corvi/contracts/subagents";

/** The thinking levels pi's `--thinking` takes; opencode's equivalent is mapped from them by the
 * harness adapters. An unknown level is passed through (the harness decides), so this list is
 * the documented vocabulary, not a validation gate. */
export const SUBAGENT_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One configured subagent profile: what a created instance starts, and with what. */
export type Profile = {
  /** How the page and the menu name it. */
  readonly label: string;
  /** The harness to start. */
  readonly harness: SubagentHarness;
  /** The model to pass to the harness (`--model`); absent means the harness's own default. */
  readonly model?: string;
  /** The thinking effort, mapped per harness (`pi --thinking`); absent means the harness's
   * default. */
  readonly effort?: string;
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

const isHarness = Schema.is(SubagentHarness);
const isPhase = Schema.is(ChangePhase);

/** The frontmatter block and the body below it. A file without the `---` pair has no settings to
 * read, whatever its body says. The raw frontmatter text comes back too, so a caller can rewrite
 * a body without reprinting what the user wrote above it. */
export const splitFrontmatter = (
  text: string,
): { fields: unknown; frontmatter: string; body: string } | undefined => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  let fields: unknown;
  try {
    fields = parseYaml(match[1] ?? "");
  } catch {
    return undefined;
  }
  return { fields, frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
};

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

  const rawHarness = fields["harness"];
  const harness = isHarness(rawHarness) ? rawHarness : undefined;
  if (!harness) reasons.push("harness: must be pi or opencode");

  const model = optionalString(fields["model"]);
  if (model === null) reasons.push("model: a string");

  const effort = optionalString(fields["effort"]);
  if (effort === null) reasons.push("effort: a string");

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

  if (reasons.length > 0 || !harness) return invalid(...reasons);

  return Result.succeed({
    label,
    harness,
    model: model ?? undefined,
    effort: effort ?? undefined,
    phases,
    body: split.body,
  });
};

/** An absent value stays absent; a present one has to be a non-empty string. `null` means the
 * field was present but wrong (the caller records a reason). */
const optionalString = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};
