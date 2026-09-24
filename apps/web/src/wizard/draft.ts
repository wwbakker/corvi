import type { Selection } from "../app-root/api.ts";
import { slugFor, type ChangeDraft } from "../domain/change.ts";
import type { StepContext, StepPick } from "../integrations/client.tsx";
import { firstHeading, setFirstHeading } from "./plan.ts";

/**
 * The wizard's form, kept outside the component so that leaving `/new` does not lose it.
 *
 * A draft is not a change: nothing is written until "Create idea" is posted, and nothing is
 * persisted — it lives as long as the page does. The App owns it, the Wizard edits it, and the
 * column draws it as the row under Ideas that leads back to it.
 */
export type Draft = {
  id: string;
  branch: string;
  /** The starting text of PLAN.md, sent as the creation's `plan`. Its first heading names the
   * change: the wizard's title field is that heading, read-only. */
  plan: string;
  repos: Selection[];
  /** What each step's field shows, under the extension's own name: the pick's label (an issue
   * key or number) and name. */
  picks: Record<string, StepPick>;
  /** Each step's pick, under the extension's own name — what `create` posts as `extensions`. */
  payloads: Record<string, unknown>;
  /** The workspace chosen inside the form, which decides the change's context when the switcher
   * says "All work". */
  picked?: string;
  /** Whether the id and branch are still following the plan's heading, or were set by hand (or
   * by a picked issue). Restored with the rest, so returning and typing a heading leaves an
   * edited id alone. */
  idTouched: boolean;
  branchTouched: boolean;
  /** Whether the template has filled the plan: it seeds a fresh draft once, and never rewrites
   * the text you have. */
  planSeeded: boolean;
  /** The first heading of the template that seeded the plan. The plan's heading is "still the
   * template's" while it reads exactly this — only then may a picked issue name the change. */
  headingSeed: string;
};

export const EMPTY_DRAFT: Draft = {
  id: "",
  branch: "",
  plan: "",
  repos: [],
  picks: {},
  payloads: {},
  idTouched: false,
  branchTouched: false,
  planSeeded: false,
  headingSeed: "",
};

/** What the column calls the draft: the plan's heading once there is one, "New idea" until
 * then. */
export const draftLabel = (draft: Draft): string => firstHeading(draft.plan) || "New idea";

/** A change to the draft, or a function of it. The function form is what a setter that composes
 * several fields needs — a step's own slot, say — because it reads the draft in hand rather than
 * the copy its render closed over. */
export type DraftPatch = Partial<Draft> | ((draft: Draft) => Partial<Draft>);

/** The draft with a patch applied: the App's one way of writing it. */
export const applyPatch = (draft: Draft, patch: DraftPatch): Draft => ({
  ...draft,
  ...(typeof patch === "function" ? patch(draft) : patch),
});

/** The patch a plan edit makes: the document, and the id and branch that follow its heading
 * until you edit either by hand — the heading is the title's one-way source. */
export const planPatch = (draft: Draft, plan: string): Partial<Draft> => {
  const heading = firstHeading(plan);
  return {
    plan,
    ...(draft.idTouched ? {} : { id: slugFor(heading) }),
    ...(draft.branchTouched ? {} : { branch: slugFor(heading) }),
  };
};

/** The patch a step's pick makes: what its field shows, and — while the plan's heading is still
 * exactly the template's — the heading itself, so a picked issue names the change. Your own
 * words are never rewritten. */
export const pickPatch = (
  draft: Draft,
  extension: string,
  pick: StepPick | undefined,
): Partial<Draft> => {
  const picks = { ...draft.picks };
  if (pick === undefined) delete picks[extension];
  else picks[extension] = pick;
  if (pick && firstHeading(draft.plan) === draft.headingSeed) {
    return { picks, ...planPatch(draft, setFirstHeading(draft.plan, pick.name)) };
  }
  return { picks };
};

/** The patch the template makes to a fresh draft: the plan, seeded once — while it is still
 * empty, so a draft already written in is never rewritten — with the template's heading
 * remembered as the one a picked issue may replace. */
export const seedPatch = (draft: Draft, template: string): Partial<Draft> => ({
  ...(draft.plan === "" ? planPatch(draft, template) : {}),
  planSeeded: true,
  headingSeed: firstHeading(template),
});

/**
 * What the wizard's steps share, built from the draft: the change id and branch they may
 * prefill, the repositories picked so far, their pick's place in the form, and their own slot of
 * the creation record.
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
    // What the step's field shows, and the issue's name — which names the change while the
    // plan's heading is still the template's (pickPatch).
    setPick: (extension, pick) => onChange((draft) => pickPatch(draft, extension, pick)),
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
 * than as a field of `change.json` (apps/server/src/change/routes.ts). The workspace is resolved here — the
 * switcher's where it names one — because the draft's own `picked` is only a fallback.
 */
export function toChangeDraft(draft: Draft, workspace?: string): ChangeDraft & { plan: string } {
  return {
    id: draft.id,
    branch: draft.branch,
    // The plan's first heading names the change; a heading-less plan leaves the naming to the
    // ticket's summary. The core marks a named change's title the user's (titleEdited), so no
    // title source overwrites the heading's words later.
    ...(firstHeading(draft.plan) ? { title: firstHeading(draft.plan) } : {}),
    // The wizard makes an idea: the work (branch, worktree, ticket) starts later, from its page.
    state: "Ideation",
    // The starting text of PLAN.md, then the agent's and yours to shape.
    plan: draft.plan,
    workspace,
    checkouts: draft.repos.map((r) => ({
      path: r.path,
      location: r.location,
      branch: r.branch,
      ...(r.base !== undefined ? { base: r.base } : {}),
      ...(r.target !== undefined ? { target: r.target } : {}),
    })),
    // Each step's pick, under the extension's own name: the core stores it and never looks
    // inside.
    extensions: draft.payloads,
  };
}
