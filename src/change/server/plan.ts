import { join } from "node:path";
import { PLAN_FILE, type Change } from "../../domain/change.ts";
import { runtimeConfig } from "../../workspace/server/index.ts";
import { changeDir } from "./store.ts";

/**
 * The prompt that briefs an agent about an idea.
 *
 * Enforcement of "only PLAN.md may change while you are in Ideation" is not Corvi's to attempt: pi
 * runs with the user's own permissions and there is no sandbox here, and a symlinked repository
 * cannot be made read-only. So Corvi states the rule instead of pretending to enforce it — the
 * prompt is pasted into the change's terminal by the route, and its text (the rule included) is
 * the setting, so what the agent is told is yours to change.
 */

/** The briefing for one change: the configured template with the change's own values filled in.
 * `{title}` falls back to the id, and `{state}` to what an absent state means, so a prompting
 * typo in a template cannot leave a hole. */
export const ideationPromptFor = (change: Change): string =>
  runtimeConfig().ideationPrompt
    .replaceAll("{id}", change.id)
    .replaceAll("{title}", change.title ?? change.branch ?? change.id)
    .replaceAll("{plan}", join(changeDir(change.id), PLAN_FILE))
    .replaceAll("{state}", change.state ?? "In Progress");
