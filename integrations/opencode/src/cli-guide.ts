/**
 * The one paragraph every agent in a Corvi terminal gets about `corvi` — behind the pane gate
 * (`CORVI_CHANGE_ID`, which the session sets in every pane), so opencode outside Corvi sees
 * nothing of this. The details live in the CLI's own group help (`corvi change`, `corvi action`,
 * `corvi subagent` each print theirs); this is only the pointer, deliberately a sentence or two,
 * because every run's prompt pays for it.
 */

/** The guide text. Kept identical to `integrations/pi/src/cli-guide.ts`: each plugin is loaded
 * by its own agent outside Corvi's module graph and cannot share an import with the other (see
 * this package's AGENTS.md), so the text is stated twice and `test/cliGuide.test.ts` pins the
 * two equal. */
export const guideText = (changeId: string): string =>
  `This pane belongs to Corvi change ${changeId} (\`--change\` defaults to it). The \`corvi\` CLI is the change's control plane: \`corvi change\`, \`corvi action\`, and \`corvi subagent\` each print their own usage.`;

/** The `experimental.chat.system.transform` half, pure over its output and an environment: the
 * guide joins the system prompt inside Corvi, and nothing is touched outside. Pushed only once —
 * the hook may see a request more than a text should be said. */
export const applyGuide = (system: string[], env: Record<string, string | undefined>): void => {
  const changeId = env.CORVI_CHANGE_ID;
  if (changeId === undefined || changeId === "") return;
  const text = guideText(changeId);
  if (!system.includes(text)) system.push(text);
};
