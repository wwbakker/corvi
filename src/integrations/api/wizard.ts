/** One step of the "Create change" wizard, as the server declares it. Steps run in phases:
 * `issue` steps come before the change details (they prefill the id and branch), `repos`
 * steps come after the repositories are picked (they need the repositories to look at).
 * Within a phase, registration order. The step's *content* is the extension's client
 * component; this declaration is what the page is told exists. */
export type WizardStep = {
  /** Namespaced by the extension: it doubles as the payload key on the change record. */
  id: string;
  /** What the step's tab in the wizard says. */
  title: string;
  phase: "issue" | "repos";
};
