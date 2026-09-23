import { basename, join } from "node:path";
import { renderActionBody } from "@corvi/actions/render";
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
 *
 * The placeholder filling is the actions package's one renderer (`@corvi/actions/render`); the
 * template is configuration (`config.ideationPrompt`, empty meaning the shipped `brief` action's
 * body). A `brief.md` that shadows the built-in is honored by the action's own run route
 * (`apps/server/src/actions/server/run.ts`); this is the legacy paste's text, which the PlanCard
 * button uses until the action menu replaces it.
 */

/** The briefing for one change: the configured template with the change's own values filled in. */
export const ideationPromptFor = (change: Change): string =>
  renderActionBody(
    runtimeConfig().ideationPrompt,
    {
      id: change.id,
      title: change.title,
      branch: change.branch,
      plan: join(changeDir(change.id), PLAN_FILE),
      state: change.state,
      dir: changeDir(change.id),
      repos: (change.checkouts ?? []).map((spec) => basename(spec.path)),
    },
    "text",
  );
