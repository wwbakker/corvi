/** The fields a harness profile shares with a subagent profile: which harness, model and effort,
 * the extra models, the instructions, and the four sections of names.
 *
 * Parsing is pure and total, exactly like the subagent profile parser that composes it: a
 * frontmatter object is either one well-formed `HarnessProfileFields` or the reasons it is not,
 * and unknown keys are tolerated so a file can carry `description` or a comment for another
 * reader. Model and effort are checked loosely on purpose — a model catalog changes with the
 * harness, so an unknown id is a launch concern, never a parse failure.
 *
 * `harness:` always names the program (`pi` | `opencode`); the profile a file is based on goes in
 * `basedOnHarnessProfile:`. One key, one meaning, in both file kinds.
 *
 * A section is `{ mode, include, exclude }`. An absent `mode` means "keep the parent's mode and
 * add my list entries"; a present `mode` replaces the whole section, lists included. That one
 * rule is what `mergeHarnessProfileFields` implements, and it is the same rule the generator
 * writes settings for. */
import { Result, Schema } from "effect";

import { Harness, HarnessProfileSectionMode } from "@corvi/contracts/harness-profiles";

/** The four sections a harness profile can narrow or widen. */
export type HarnessProfileSectionName = "extensions" | "skills" | "packages" | "mcp";

/** One section: a mode, and the names to add to or remove from the base's list. */
export type HarnessProfileSection = {
  readonly mode?: HarnessProfileSectionMode;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

/** The effective harness-profile settings. Absent values inherit from the profile it is based on. */
export type HarnessProfileFields = {
  /** Which program runs it. A built-in chain end declares it; every other file inherits it, and a
   * file that declares a different one is the resolver's harness-switch error. */
  readonly harness?: Harness;
  readonly model?: string;
  readonly effort?: string;
  /** The model ids a `pi` session may switch between; an empty list is meaningful. */
  readonly enabledModels?: readonly string[];
  /** Markdown that replaces the base `AGENTS.md`; absent inherits it, an empty string clears it. */
  readonly instructions?: string;
  readonly extensions: HarnessProfileSection;
  readonly skills: HarnessProfileSection;
  readonly packages: HarnessProfileSection;
  readonly mcp: HarnessProfileSection;
};

/** A file's fields before the chain is resolved: the shared settings plus the profile it is based
 * on. */
export type HarnessProfileFileFields = HarnessProfileFields & {
  /** The harness profile this file is layered on, by id (`normaal`) or key (`global:normaal`).
   * Absent at a built-in chain end, and in a subagent profile that follows the default. */
  readonly basedOnHarnessProfile?: string;
};

/** Why a frontmatter object is not a set of harness-profile fields. Every reason names a field. */
export type InvalidHarnessProfileFields = {
  readonly reasons: readonly string[];
};

const invalid = (
  ...reasons: string[]
): Result.Result<HarnessProfileFileFields, InvalidHarnessProfileFields> => Result.fail({ reasons });

const emptySection = (): HarnessProfileSection => ({ include: [], exclude: [] });

export const emptyHarnessProfileFields: HarnessProfileFields = {
  extensions: emptySection(),
  skills: emptySection(),
  packages: emptySection(),
  mcp: emptySection(),
};

const isHarness = Schema.is(Harness);
const isSectionMode = Schema.is(HarnessProfileSectionMode);

/** An absent value stays absent; a present one has to be a non-empty string. `null` means the
 * field was present but wrong (the caller records a reason). */
const optionalString = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** An absent list stays absent; a present one has to be a list of non-empty strings. `null`
 * means the field was present but wrong. */
const optionalNames = (value: unknown): readonly string[] | null | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return null;
  const names = value.map((name) => name.trim());
  return names.some((name) => name === "") ? null : names;
};

/** One section from its raw frontmatter value. Absent and `null` are an empty section; anything
 * that is not an object with a valid mode and name lists is a reason. */
const parseSection = (
  name: HarnessProfileSectionName,
  value: unknown,
  reasons: string[],
): HarnessProfileSection => {
  if (value === undefined || value === null) return emptySection();
  if (typeof value !== "object" || Array.isArray(value)) {
    reasons.push(`${name}: an object with mode, include or exclude`);
    return emptySection();
  }
  const fields = value as Record<string, unknown>;
  const rawMode = fields["mode"];
  const mode = rawMode === undefined ? undefined : isSectionMode(rawMode) ? rawMode : null;
  if (mode === null) reasons.push(`${name}.mode: all or none`);
  const include = optionalNames(fields["include"]);
  if (include === null) reasons.push(`${name}.include: a list of names`);
  const exclude = optionalNames(fields["exclude"]);
  if (exclude === null) reasons.push(`${name}.exclude: a list of names`);
  return {
    ...(mode === undefined || mode === null ? {} : { mode }),
    include: include ?? [],
    exclude: exclude ?? [],
  };
};

/** Parse the shared fields out of one frontmatter object. Total: every mistake is a reason. */
export const parseHarnessProfileFields = (
  fields: Record<string, unknown>,
): Result.Result<HarnessProfileFileFields, InvalidHarnessProfileFields> => {
  const reasons: string[] = [];

  const rawHarness = fields["harness"];
  const harness = rawHarness === undefined ? undefined : isHarness(rawHarness) ? rawHarness : null;
  if (harness === null) reasons.push("harness: pi or opencode");

  const basedOnHarnessProfile = optionalString(fields["basedOnHarnessProfile"]);
  if (basedOnHarnessProfile === null) {
    reasons.push("basedOnHarnessProfile: a harness profile id or key");
  }

  const model = optionalString(fields["model"]);
  if (model === null) reasons.push("model: a string");

  const effort = optionalString(fields["effort"]);
  if (effort === null) reasons.push("effort: a string");

  const enabledModels = optionalNames(fields["enabledModels"]);
  if (enabledModels === null) reasons.push("enabledModels: a list of model ids");

  const rawInstructions = fields["instructions"];
  const instructions =
    rawInstructions === undefined ? undefined : typeof rawInstructions === "string" ? rawInstructions : null;
  if (instructions === null) reasons.push("instructions: a string");

  const extensions = parseSection("extensions", fields["extensions"], reasons);
  const skills = parseSection("skills", fields["skills"], reasons);
  const packages = parseSection("packages", fields["packages"], reasons);
  const mcp = parseSection("mcp", fields["mcp"], reasons);

  if (reasons.length > 0) return invalid(...reasons);

  return Result.succeed({
    ...(harness === undefined || harness === null ? {} : { harness }),
    ...(basedOnHarnessProfile === undefined || basedOnHarnessProfile === null
      ? {}
      : { basedOnHarnessProfile }),
    ...(model === undefined || model === null ? {} : { model }),
    ...(effort === undefined || effort === null ? {} : { effort }),
    ...(enabledModels === undefined || enabledModels === null ? {} : { enabledModels }),
    ...(instructions === undefined || instructions === null ? {} : { instructions }),
    extensions,
    skills,
    packages,
    mcp,
  });
};

/** Merge one section: a child mode replaces the section outright; without a mode, the child's
 * lists append to the parent's. */
export const mergeHarnessProfileSection = (
  base: HarnessProfileSection,
  child: HarnessProfileSection,
): HarnessProfileSection =>
  child.mode === undefined
    ? {
        ...(base.mode === undefined ? {} : { mode: base.mode }),
        include: [...base.include, ...child.include],
        exclude: [...base.exclude, ...child.exclude],
      }
    : { mode: child.mode, include: [...child.include], exclude: [...child.exclude] };

/** Merge a child's fields onto its parent's: scalars — child wins, absent inherits; sections —
 * see `mergeHarnessProfileSection`. The profile a file is based on is not a setting and never
 * lands in the result. */
export const mergeHarnessProfileFields = (
  base: HarnessProfileFields,
  child: HarnessProfileFields,
): HarnessProfileFields => {
  const pick = <T>(childValue: T | undefined, baseValue: T | undefined): T | undefined =>
    childValue === undefined ? baseValue : childValue;
  const harness = pick(child.harness, base.harness);
  const model = pick(child.model, base.model);
  const effort = pick(child.effort, base.effort);
  const enabledModels = pick(child.enabledModels, base.enabledModels);
  const instructions = pick(child.instructions, base.instructions);
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(enabledModels === undefined ? {} : { enabledModels }),
    ...(instructions === undefined ? {} : { instructions }),
    extensions: mergeHarnessProfileSection(base.extensions, child.extensions),
    skills: mergeHarnessProfileSection(base.skills, child.skills),
    packages: mergeHarnessProfileSection(base.packages, child.packages),
    mcp: mergeHarnessProfileSection(base.mcp, child.mcp),
  };
};
