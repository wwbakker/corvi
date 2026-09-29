/**
 * The one paragraph every agent in a Corvi terminal gets about `corvi` — behind the pane gate
 * (`CORVI_CHANGE_ID`, which the session sets in every pane), so a pi outside Corvi sees nothing
 * of this. The details live in the CLI's own group help (`corvi change`, `corvi action`,
 * `corvi subagent` each print theirs); this is only the pointer, deliberately a sentence or two,
 * because every run's prompt pays for it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The guide text. Kept identical to `integrations/opencode/src/cli-guide.ts`: each extension is
 * loaded by its own agent outside Corvi's module graph and cannot share an import with the other
 * (see this package's AGENTS.md), so the text is stated twice and
 * `test/cliGuide.test.ts` pins the two equal. */
export const guideText = (changeId: string): string =>
  `This pane belongs to Corvi change ${changeId} (\`--change\` defaults to it). The \`corvi\` CLI is the change's control plane: \`corvi change\`, \`corvi action\`, and \`corvi subagent\` each print their own usage.`;

/** The system-prompt section the guide rides in. */
export const GUIDE_SECTION = "corvi_cli";

/** The `before_agent_start` half, pure over its event and an environment: the section is set
 * inside Corvi and deleted outside, so nothing pi renders changes for anyone else. */
export const applyGuide = (
  event: { systemPromptOptions: { sections: Record<string, string | undefined> } },
  env: Record<string, string | undefined>,
): void => {
  const changeId = env.CORVI_CHANGE_ID;
  if (changeId !== undefined && changeId !== "") {
    event.systemPromptOptions.sections[GUIDE_SECTION] = guideText(changeId);
  } else {
    delete event.systemPromptOptions.sections[GUIDE_SECTION];
  }
};

export default function cliGuide(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    applyGuide(event, process.env);
  });
}
