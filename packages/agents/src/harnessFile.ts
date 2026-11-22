/** One harness file: YAML frontmatter for the environment, the body as free-form notes for the
 * reader.
 *
 * A harness is a named, file-defined Pi environment: the agent it runs, the model and effort, the
 * extra models, the instructions, and the extension/skill/package/MCP sections. A harness that
 * names another in `harness:` inherits from it; the chain ends at one of the built-ins shipped in
 * `builtins/harnesses/` (`pi`, `pi-bare`, `opencode`). Parsing here is pure and total; the chain
 * is walked by `./harnessDiscovery`.
 *
 * `label` is required because every surface names the harness by it. A missing `harness:` is not
 * a parse failure: whether a file may be a chain end depends on which scope it came from, which
 * only discovery knows. */
import { Result } from "effect";

import { splitFrontmatter } from "@corvi/markdown/frontmatter";
import { parseHarnessFields, type HarnessFileFields } from "./harnessFields.ts";

export { splitFrontmatter };
export {
  emptyHarnessFields,
  mergeHarnessFields,
  mergeHarnessSection,
  parseHarnessFields,
  type HarnessFields,
  type HarnessFileFields,
  type HarnessSection,
  type HarnessSectionName,
  type InvalidHarnessFields,
} from "./harnessFields.ts";

/** The harness ids Corvi ships, and the only chain ends a harness may reach. */
export const BUILTIN_HARNESS_IDS = ["pi", "pi-bare", "opencode"] as const;

/** One parsed harness file. */
export type Harness = HarnessFileFields & {
  /** How the Harnesses page and the selectors name it. */
  readonly label: string;
};

/** Why a file is not a harness. Every reason names a field, so a log line is useful. */
export type InvalidHarnessFile = {
  readonly reasons: readonly string[];
};

const invalid = (...reasons: string[]): Result.Result<Harness, InvalidHarnessFile> =>
  Result.fail({ reasons });

/** Parse one harness file. Unknown frontmatter keys are tolerated — a harness may carry a note
 * for another reader — but every key this vocabulary knows is checked. */
export const parseHarnessFile = (text: string): Result.Result<Harness, InvalidHarnessFile> => {
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

  if (reasons.length > 0 || Result.isFailure(parsed)) return invalid(...reasons);
  return Result.succeed({ ...parsed.success, label });
};
