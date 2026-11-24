/** One harness-profile file: YAML frontmatter for the environment, the body as free-form notes
 * for the reader.
 *
 * A harness profile is a named, file-defined Pi environment: the harness (program) it runs, the
 * model and effort, the extra models, the instructions, and the extension/skill/package/MCP
 * sections. A profile that names another in `basedOnHarnessProfile:` inherits from it; the chain
 * ends at one of the built-ins shipped in `builtins/harnesses/` (`pi`, `pi-bare`, `opencode`).
 * Parsing here is pure and total; the chain is walked by `./harnessProfileDiscovery`.
 *
 * `label` is required because every surface names the profile by it. A missing
 * `basedOnHarnessProfile:` is not a parse failure: whether a file may be a chain end depends on
 * which scope it came from, which only discovery knows. A user file without one is based on the
 * built-in `pi`. */
import { Result } from "effect";

import { splitFrontmatter } from "@corvi/markdown/frontmatter";
import { parseHarnessProfileFields, type HarnessProfileFileFields } from "./harnessProfileFields.ts";

export { splitFrontmatter };
export {
  emptyHarnessProfileFields,
  mergeHarnessProfileFields,
  mergeHarnessProfileSection,
  parseHarnessProfileFields,
  type HarnessProfileFields,
  type HarnessProfileFileFields,
  type HarnessProfileSection,
  type HarnessProfileSectionName,
  type InvalidHarnessProfileFields,
} from "./harnessProfileFields.ts";

/** The harness-profile ids Corvi ships, and the only chain ends a profile may reach. */
export const BUILTIN_HARNESS_PROFILE_IDS = ["pi", "pi-bare", "opencode"] as const;

/** One parsed harness-profile file. */
export type HarnessProfile = HarnessProfileFileFields & {
  /** How the Harness profiles page and the selectors name it. */
  readonly label: string;
};

/** Why a file is not a harness profile. Every reason names a field, so a log line is useful. */
export type InvalidHarnessProfileFile = {
  readonly reasons: readonly string[];
};

const invalid = (...reasons: string[]): Result.Result<HarnessProfile, InvalidHarnessProfileFile> =>
  Result.fail({ reasons });

/** Parse one harness-profile file. Unknown frontmatter keys are tolerated — a file may carry a
 * note for another reader — but every key this vocabulary knows is checked. */
export const parseHarnessProfileFile = (
  text: string,
): Result.Result<HarnessProfile, InvalidHarnessProfileFile> => {
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

  if (reasons.length > 0 || Result.isFailure(parsed)) return invalid(...reasons);
  return Result.succeed({ ...parsed.success, label });
};
