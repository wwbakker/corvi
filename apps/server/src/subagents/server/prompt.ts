/** Rendering a subagent profile's body into the first message of a created instance.
 *
 * The profile's body is its initial prompt: the same facts an action gets (`{id}`, `{title}`,
 * `{branch}`, `{plan}`, `{state}`, `{dir}`, `{repos}`) plus `{prompt}` for the caller's task. The
 * engine (`@corvi/actions/render`) only substitutes; the profile-specific rules live here. A body
 * with the `{prompt}` mark takes the task in place; a body without it gets the task appended as a
 * final `## Task` section; a whitespace-only body is the task alone. With no task (or a
 * whitespace-only one) the mark takes `AWAIT_INSTRUCTIONS`, so a created instance always has a
 * non-empty first message. */
import { renderActionBody } from "@corvi/actions/render";

import type { ChangeFacts } from "../../change/server/index.ts";

/** Fills the `{prompt}` mark when no task was given, so create always has a first message. */
export const AWAIT_INSTRUCTIONS = "Please await your initial instructions.";

export const renderSubagentBody = (
  body: string,
  facts: ChangeFacts,
  prompt: string | undefined,
): string => {
  // The task (and its fallback) is settled before rendering, so an empty prompt never leaves a
  // `{prompt}` hole.
  const givenTask = prompt !== undefined && prompt.trim() !== "";
  const task = givenTask ? prompt.trim() : AWAIT_INSTRUCTIONS;
  // A whitespace-only body is a body-less profile: the task alone, or the instruction when there
  // is none.
  if (body.trim() === "") return task;
  // The `## Task` append and the `{prompt}` substitution are mutually exclusive: the engine gets
  // a `prompt` fact only for a body that names the mark.
  if (body.includes("{prompt}")) {
    const rendered = renderActionBody(body, { ...facts, prompt: task }, "text").trimEnd();
    return rendered.trim() === "" ? task : rendered;
  }
  const rendered = renderActionBody(body, facts, "text").trimEnd();
  // A non-whitespace body can still render to nothing (only `{repos}` on a change with none):
  // the task/instruction is the guaranteed message then.
  if (rendered.trim() === "") return task;
  return givenTask ? `${rendered}\n\n## Task\n\n${task}` : rendered;
};
