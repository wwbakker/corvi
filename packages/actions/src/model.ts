/** The action file vocabulary: one Markdown file per action, YAML frontmatter for the delivery,
 * body for the text or command.
 *
 * Parsing is pure and total: a file is either one well-formed `Action` or a list of reasons it
 * is not. A malformed file is skipped by discovery with those reasons — it never takes the menu
 * down, and the reasons are what a log line should say.
 *
 * The shape matches pi's own prompt templates (Markdown + YAML frontmatter) on purpose: the same
 * file reads as an action here and, later, could be sent as a `/name` template there. */
import { Either, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import { ChangePhase } from "@corvi/contracts/changes";
import { ActionKind, ActionTarget } from "@corvi/contracts/actions";

/** One configured action: what to deliver, where, and how. */
export type Action = {
  /** How the menu names it. */
  readonly label: string;
  /** Text for an agent, or a shell command. */
  readonly kind: ActionKind;
  /** The pane you are on (`active`), the window an agent runs in (`agent`), or a new window. */
  readonly target: ActionTarget;
  /** What a started window runs — required for a prompt into a new window (otherwise the text
   * would land in a shell), the fallback for `agent` with none running (default `pi`). */
  readonly start?: string;
  /** Prompt only: press Enter after pasting. Without it the text waits in the agent's editor. */
  readonly submit: boolean;
  /** When the action is offered; absent means every phase. */
  readonly phases?: readonly ChangePhase[];
  /** Command only: keep the finished window and let it call you. Implies keeping the window. */
  readonly notify: boolean;
  /** Command only: freeze the pane over its output instead of closing the window at the end. */
  readonly keepOpen: boolean;
  /** The prompt text or the shell command. */
  readonly body: string;
};

/** Why a file is not an action. Every reason names a field, so a log line is useful. */
export type InvalidActionFile = {
  readonly reasons: readonly string[];
};

const invalid = (...reasons: string[]): Either.Either<Action, InvalidActionFile> =>
  Either.left({ reasons });

const isKind = Schema.is(ActionKind);
const isTarget = Schema.is(ActionTarget);
const isPhase = Schema.is(ChangePhase);

/** The frontmatter block and the body below it. A file without the `---` pair has no delivery
 * instructions to read, whatever its body says. The raw frontmatter text comes back too, so a
 * caller can rewrite a body without reprinting what the user wrote above it. */
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

/** Parse one action file. Unknown frontmatter keys are tolerated — a file may carry a
 * `description` for pi and still be an action here — but every key this vocabulary knows is
 * checked, and contradictions (a command that submits) are refused rather than ignored. */
export const parseActionFile = (text: string): Either.Either<Action, InvalidActionFile> => {
  const split = splitFrontmatter(text);
  if (!split || typeof split.fields !== "object" || split.fields === null) {
    return invalid("missing or unparseable YAML frontmatter");
  }
  const fields = split.fields as Record<string, unknown>;
  const reasons: string[] = [];

  const rawLabel = fields["label"];
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (!label) reasons.push("label: required, a string");

  const rawKind = fields["kind"];
  const kind = isKind(rawKind) ? rawKind : undefined;
  if (!kind) reasons.push("kind: must be prompt or command");

  const rawTarget = fields["target"];
  const target = rawTarget === undefined ? "active" : isTarget(rawTarget) ? rawTarget : undefined;
  if (target === undefined) reasons.push("target: must be active, agent or new");

  const rawStart = fields["start"];
  const start =
    rawStart === undefined
      ? undefined
      : typeof rawStart === "string" && rawStart.trim() !== ""
        ? rawStart
        : undefined;
  if (rawStart !== undefined && start === undefined) reasons.push("start: a string");

  const rawSubmit = fields["submit"];
  const submit = rawSubmit === undefined ? false : typeof rawSubmit === "boolean" ? rawSubmit : undefined;
  if (submit === undefined) reasons.push("submit: a boolean");

  const rawPhases = fields["phases"];
  const phases =
    rawPhases === undefined
      ? undefined
      : Array.isArray(rawPhases) && rawPhases.every(isPhase)
        ? rawPhases
        : undefined;
  if (rawPhases !== undefined && phases === undefined) {
    reasons.push("phases: must be a list of the change's phases");
  }

  const rawNotify = fields["notify"];
  const notify = rawNotify === undefined ? false : typeof rawNotify === "boolean" ? rawNotify : undefined;
  if (notify === undefined) reasons.push("notify: a boolean");

  const rawKeepOpen = fields["keepOpen"];
  const keepOpen =
    rawKeepOpen === undefined ? false : typeof rawKeepOpen === "boolean" ? rawKeepOpen : undefined;
  if (keepOpen === undefined) reasons.push("keepOpen: a boolean");

  if (reasons.length > 0 || !kind || !target || submit === undefined || notify === undefined || keepOpen === undefined) {
    return invalid(...reasons);
  }

  // The contradictions below only make sense once the fields above are known good.
  if (kind === "command") {
    if (target === "agent") reasons.push("target: a command cannot target an agent window");
    if (submit) reasons.push("submit: applies to prompts; a command always submits");
  } else {
    if (notify) reasons.push("notify: applies to commands");
    if (keepOpen) reasons.push("keepOpen: applies to commands");
    if (target === "new" && !start) reasons.push("start: required, or the prompt would land in a shell");
  }
  if (reasons.length > 0) return invalid(...reasons);

  return Either.right({
    label,
    kind,
    target,
    start: start ?? (kind === "prompt" && target === "agent" ? "pi" : undefined),
    submit: kind === "prompt" && submit,
    phases,
    notify,
    keepOpen,
    body: split.body,
  });
};
