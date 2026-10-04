/** Filling an action's body with the change's facts — the one placeholder engine.
 *
 * This absorbs what `@corvi/agents/prompt`'s `fillBriefing` did, so there is a single answer to
 * "which placeholders exist and how are they escaped". A prompt pasted to a human-read editor
 * gets the values as written; a command run by a shell gets them shell-escaped, because a Jira
 * title can contain anything.
 *
 * `{prompt}` is the caller's own task text, filled last and only when supplied: an action body
 * that does not use it is left untouched, and a task may itself contain `{id}` without being
 * re-expanded by the earlier placeholders.
 *
 * Enforcement of "only PLAN.md may change while you are in Ideation" is not Corvi's to attempt
 * (pi runs with the user's own permissions) — the prompt states the rule instead, and its text
 * is the user's to change. */

/** The change's own values, as an action's body needs them. `{title}` falls back to the branch,
 * then the id, and `{state}` to what an absent phase means, so a placeholder typo in a template
 * cannot leave a hole. `prompt` is the caller's own task text, present only when there is one
 * (subagent bodies pass it; actions do not). */
export type ActionFacts = {
  readonly id: string;
  readonly title?: string;
  readonly branch?: string;
  /** The path of the plan file, as the app resolved it. */
  readonly plan: string;
  readonly state?: string;
  /** The change's directory. */
  readonly dir?: string;
  /** The names of the change's checkouts. */
  readonly repos?: readonly string[];
  /** The caller's task, filled into `{prompt}` last so its own braces are data. */
  readonly prompt?: string;
};

/** `text` for a prompt pasted into an editor, `shell` for a command a shell runs — the
 * difference being whether substituted values are escaped. */
export type RenderMode = "text" | "shell";

/** POSIX single-quote wrapping: whatever a value contains, it is data to the shell. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Fill a template with the change's facts. */
export const renderActionBody = (template: string, facts: ActionFacts, mode: RenderMode): string => {
  const wrap = (value: string): string => (mode === "shell" ? shellQuote(value) : value);
  const values: Record<string, string> = {
    "{id}": facts.id,
    "{title}": facts.title ?? facts.branch ?? facts.id,
    "{branch}": facts.branch ?? "",
    "{plan}": facts.plan,
    "{state}": facts.state ?? "Implementation",
    "{dir}": facts.dir ?? "",
    "{repos}": (facts.repos ?? []).join(", "),
  };
  // Last and only when supplied, so a literal `{prompt}` in an action body stays put and a task
  // that itself contains `{id}` is data, not another template.
  if (facts.prompt !== undefined) values["{prompt}"] = facts.prompt;
  let out = template;
  for (const [placeholder, value] of Object.entries(values)) {
    // A function replacer, so `$&`/`$$`/`` $` ``/`$'` in a value are literal data, not patterns.
    out = out.replaceAll(placeholder, () => wrap(value));
  }
  return out;
};
