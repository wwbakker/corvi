import type { Selection } from "../app-root/api.ts";
import type { ChangeDraft } from "../domain/change.ts";
import type { StepContext } from "../integrations/client.tsx";

/**
 * The wizard's form, kept outside the component so that leaving `/new` does not lose it.
 *
 * A draft is not a change: nothing is written until "Create idea" is posted, and nothing is
 * persisted — it lives as long as the page does. The App owns it, the Wizard edits it, and the
 * column draws it as the row under Ideas that leads back to it.
 */
export type Draft = {
  /** Which step was open: the wizard reopens on it. */
  step: number;
  id: string;
  branch: string;
  title: string;
  /** The starting text of PLAN.md, sent as the creation's `plan`. */
  description: string;
  repos: Selection[];
  ticket?: string;
  /** Each step's pick, under the extension's own name — what `create` posts as `extensions`. */
  payloads: Record<string, unknown>;
  /** The workspace chosen inside the form, which decides the change's context when the switcher
   * says "All work". */
  picked?: string;
  /** Whether the id and branch are still following the title, or were set by hand (or by a
   * picked issue). Restored with the rest, so returning and typing a title leaves an edited id
   * alone. */
  idTouched: boolean;
  branchTouched: boolean;
};

export const EMPTY_DRAFT: Draft = {
  step: 0,
  id: "",
  branch: "",
  title: "",
  description: "",
  repos: [],
  payloads: {},
  idTouched: false,
  branchTouched: false,
};

/** What the column calls the draft: the title once there is one, "New idea" until then. */
export const draftLabel = (draft: Draft): string => draft.title.trim() || "New idea";

/** A change to the draft, or a function of it. The function form is what a setter that composes
 * several fields needs — a step's own slot, say — because it reads the draft in hand rather than
 * the copy its render closed over. */
export type DraftPatch = Partial<Draft> | ((draft: Draft) => Partial<Draft>);

/** The draft with a patch applied: the App's one way of writing it. */
export const applyPatch = (draft: Draft, patch: DraftPatch): Draft => ({
  ...draft,
  ...(typeof patch === "function" ? patch(draft) : patch),
});

/**
 * What the wizard's steps share, built from the draft: the change id and branch they may
 * prefill, the repositories picked so far, the ticket the details step names, and their own slot
 * of the creation record.
 *
 * Every setter writes through `onChange` to the draft the App owns, which is what makes a step's
 * pick outlive the step's own unmounting: a step that is shown again reads `payload` back.
 */
export function stepContext(
  draft: Draft,
  workspace: string | undefined,
  onChange: (patch: DraftPatch) => void,
): StepContext {
  return {
    workspace,
    draft: { id: draft.id, branch: draft.branch },
    setDraft: (patch) => {
      if (patch.id !== undefined) onChange({ id: patch.id, idTouched: true });
      if (patch.branch !== undefined) onChange({ branch: patch.branch, branchTouched: true });
    },
    repos: draft.repos,
    ticket: draft.ticket,
    setTicket: (label) => onChange({ ticket: label }),
    // The step's own slot, read back when a draft that was left open is reopened.
    payload: (extension) => draft.payloads[extension],
    setPayload: (extension, data) =>
      onChange((draft) => {
        const payloads = { ...draft.payloads };
        if (data === undefined) delete payloads[extension];
        else payloads[extension] = data;
        return { payloads };
      }),
  };
}

/**
 * The draft as the creation to post: the one place the form's fields become the API's.
 *
 * `plan` rides beside the change's own fields because the route writes it as `PLAN.md` rather
 * than as a field of `change.json` (src/change/routes.ts). The workspace is resolved here — the
 * switcher's where it names one — because the draft's own `picked` is only a fallback.
 */
export function toChangeDraft(draft: Draft, workspace?: string): ChangeDraft & { plan: string } {
  return {
    id: draft.id,
    branch: draft.branch,
    // An empty title is no title: the ticket's summary (or the branch) can name the change.
    title: draft.title.trim() || undefined,
    // The wizard makes an idea: the work (branch, worktree, ticket) starts later, from its page.
    state: "Ideation",
    // The starting text of PLAN.md, then the agent's and yours to shape.
    plan: draft.description,
    workspace,
    repos: draft.repos.map((r) => r.path),
    direct: draft.repos.filter((r) => r.direct).map((r) => r.path),
    base: Object.fromEntries(draft.repos.filter((r) => r.base).map((r) => [r.path, r.base!])),
    // Each step's pick, under the extension's own name: the core stores it and never looks
    // inside.
    extensions: draft.payloads,
  };
}
