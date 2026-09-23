import { join } from "node:path";
import { fillBriefing } from "@corvi/agents/prompt";
import { PLAN_FILE, type Change } from "../../domain/change.ts";
import { runtimeConfig } from "../../workspace/server/index.ts";
import { changeDir } from "./store.ts";

/**
 * The prompt that briefs an agent about an idea.
 *
 * Enforcement of "only PLAN.md may change while you are in Ideation" is not Corvi's to attempt: the
 * agent runs with the user's own permissions and there is no sandbox here, and a symlinked repository
 * cannot be made read-only. So Corvi states the rule instead of pretending to enforce it — the
 * prompt is pasted into the change's terminal by the route, and its text (the rule included) is
 * the setting, so what the agent is told is yours to change.
 */

/** The briefing for one change: the configured template with the change's own values filled in
 * (`@corvi/agents/prompt` fills them; the template is configuration). */
export const ideationPromptFor = (change: Change): string =>
  fillBriefing(runtimeConfig().ideationPrompt, {
    id: change.id,
    title: change.title,
    branch: change.branch,
    plan: join(changeDir(change.id), PLAN_FILE),
    state: change.state,
  });
