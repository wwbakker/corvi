/**
 * The briefing text Corvi pastes for a change: a template in, the change's own words out.
 *
 * Enforcement of "only PLAN.md may change while you are in Ideation" is not Corvi's to attempt: pi
 * runs with the user's own permissions and there is no sandbox here, and a symlinked repository
 * cannot be made read-only. So Corvi states the rule instead of pretending to enforce it — the
 * prompt is pasted into the change's terminal by the route, and its text (the rule included) is
 * the setting, so what the agent is told is yours to change.
 *
 * The template itself is configuration (`DEFAULT_IDEATION_PROMPT` and the settings page); this
 * module only knows how the placeholders are filled, so the wording stays editable and the
 * filling stays stated once.
 */

/** The change's own values, as a briefing needs them. `title` falls back to the branch, then
 * the id, and `state` to what an absent state means, so a prompting typo in a template cannot
 * leave a hole. */
export type BriefingFacts = {
  readonly id: string;
  readonly title?: string;
  readonly branch?: string;
  /** The path of the plan file, as the app resolved it. */
  readonly plan: string;
  readonly state?: string;
};

/** Fill a briefing template with the change's facts. */
export const fillBriefing = (template: string, facts: BriefingFacts): string =>
  template
    .replaceAll("{id}", facts.id)
    .replaceAll("{title}", facts.title ?? facts.branch ?? facts.id)
    .replaceAll("{plan}", facts.plan)
    .replaceAll("{state}", facts.state ?? "Implementation");
