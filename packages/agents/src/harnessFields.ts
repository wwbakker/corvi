/** The fields a harness file shares with a subagent file: which agent, model and effort, the
 * extra models, the instructions, and the four sections of names.
 *
 * Parsing is pure and total, exactly like the profile parser that composes it: a frontmatter
 * object is either one well-formed `HarnessFields` or the reasons it is not, and unknown keys are
 * tolerated so a file can carry `description` or a comment for another reader. Model and effort
 * are checked loosely on purpose — a model catalog changes with the harness, so an unknown id is
 * a launch concern, never a parse failure.
 *
 * A section is `{ mode, include, exclude }`. An absent `mode` means "keep the parent's mode and
 * add my list entries"; a present `mode` replaces the whole section, lists included. That one
 * rule is what `mergeHarnessFields` implements, and it is the same rule the generator writes
 * settings for. */
import { Result, Schema } from "effect";

import { HarnessAgent, HarnessSectionMode } from "@corvi/contracts/harnesses";

/** The four sections a harness file can narrow or widen. */
export type HarnessSectionName = "extensions" | "skills" | "packages" | "mcp";

/** One section: a mode, and the names to add to or remove from the base's list. */
export type HarnessSection = {
  readonly mode?: HarnessSectionMode;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

/** The effective harness settings. Absent values inherit from the based-on harness. */
export type HarnessFields = {
  /** Which agent runs it. Present only at a chain's built-in end, or to override (which the
   * resolver refuses when it differs from the inherited agent). */
  readonly agent?: HarnessAgent;
  readonly model?: string;
  readonly effort?: string;
  /** The model ids a `pi` session may switch between; an empty list is meaningful. */
  readonly enabledModels?: readonly string[];
  /** Markdown that replaces the base `AGENTS.md`; absent inherits it, an empty string clears it. */
  readonly instructions?: string;
  readonly extensions: HarnessSection;
  readonly skills: HarnessSection;
  readonly packages: HarnessSection;
  readonly mcp: HarnessSection;
};

/** A file's fields before the chain is resolved: the shared settings plus the id it is based on. */
export type HarnessFileFields = HarnessFields & {
  /** The harness this file inherits from. Absent only at a built-in chain end. */
  readonly harness?: string;
};

/** Why a frontmatter object is not a set of harness fields. Every reason names a field. */
export type InvalidHarnessFields = {
  readonly reasons: readonly string[];
};

const invalid = (...reasons: string[]): Result.Result<HarnessFileFields, InvalidHarnessFields> =>
  Result.fail({ reasons });

const emptySection = (): HarnessSection => ({ include: [], exclude: [] });

export const emptyHarnessFields: HarnessFields = {
  extensions: emptySection(),
  skills: emptySection(),
  packages: emptySection(),
  mcp: emptySection(),
};

const isAgent = Schema.is(HarnessAgent);
const isSectionMode = Schema.is(HarnessSectionMode);

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
const parseSection = (name: HarnessSectionName, value: unknown, reasons: string[]): HarnessSection => {
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

/** Parse the harness fields out of one frontmatter object. Total: every mistake is a reason. */
export const parseHarnessFields = (
  fields: Record<string, unknown>,
): Result.Result<HarnessFileFields, InvalidHarnessFields> => {
  const reasons: string[] = [];

  const rawHarness = optionalString(fields["harness"]);
  if (rawHarness === null) reasons.push("harness: a harness id");

  const rawAgent = fields["agent"];
  const agent = rawAgent === undefined ? undefined : isAgent(rawAgent) ? rawAgent : null;
  if (agent === null) reasons.push("agent: pi or opencode");

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

  if (reasons.length > 0 || agent === null) return invalid(...reasons);

  return Result.succeed({
    ...(rawHarness === undefined || rawHarness === null ? {} : { harness: rawHarness }),
    ...(agent === undefined ? {} : { agent }),
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
export const mergeHarnessSection = (base: HarnessSection, child: HarnessSection): HarnessSection =>
  child.mode === undefined
    ? {
        ...(base.mode === undefined ? {} : { mode: base.mode }),
        include: [...base.include, ...child.include],
        exclude: [...base.exclude, ...child.exclude],
      }
    : { mode: child.mode, include: [...child.include], exclude: [...child.exclude] };

/** Merge a child's fields onto its parent's: scalars — child wins, absent inherits; sections —
 * see `mergeHarnessSection`. The based-on id is not a setting and never lands in the result. */
export const mergeHarnessFields = (base: HarnessFields, child: HarnessFields): HarnessFields => {
  const pick = <T>(childValue: T | undefined, baseValue: T | undefined): T | undefined =>
    childValue === undefined ? baseValue : childValue;
  const agent = pick(child.agent, base.agent);
  const model = pick(child.model, base.model);
  const effort = pick(child.effort, base.effort);
  const enabledModels = pick(child.enabledModels, base.enabledModels);
  const instructions = pick(child.instructions, base.instructions);
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(enabledModels === undefined ? {} : { enabledModels }),
    ...(instructions === undefined ? {} : { instructions }),
    extensions: mergeHarnessSection(base.extensions, child.extensions),
    skills: mergeHarnessSection(base.skills, child.skills),
    packages: mergeHarnessSection(base.packages, child.packages),
    mcp: mergeHarnessSection(base.mcp, child.mcp),
  };
};
