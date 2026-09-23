import { basename } from "node:path";
import { Effect } from "effect";
import {
  checkoutSpecProblem,
  duplicateRepoNames,
  FORMAT_VERSION,
  IDEATION,
  type Change,
  type ChangeDraft,
} from "../../domain/change.ts";
import { DecodeError } from "@corvi/contracts/errors";
import { ChangeFormatTooNew } from "@corvi/changes/errors";
import { ChangeAlreadyExists, InvalidChangeDraft } from "../errors.ts";
import { readChange, writeChange } from "./store.ts";

/** The core's creation input: the plain draft the wizard collected and the `change:creating`
 * hooks transformed. */
export type CreateChangeInput = ChangeDraft;

/** Create a change from an already-transformed draft. Every invariant is re-checked here — the
 * id shape, the repository list, the starting state — so a hook's patch is applied by the
 * caller and then validated by the core before anything is written: an extension may suggest,
 * never bypass. */
export const createChange = (
  input: CreateChangeInput,
): Effect.Effect<
  Change,
  ChangeFormatTooNew | InvalidChangeDraft | ChangeAlreadyExists | DecodeError
> =>
  Effect.gen(function* () {
    const id = input.id.trim();
    if (!id || id !== basename(id) || id.startsWith(".")) {
      return yield* new InvalidChangeDraft({ message: `invalid change id: ${input.id}` });
    }
    if (yield* readChange(id)) {
      return yield* new ChangeAlreadyExists({ changeId: id, message: `change already exists: ${id}` });
    }
    // Two creation states: an idea, which needs nothing but a plan, and a change created ready
    // to work, which needs somewhere to work. A finished state is not something you create into.
    const state = input.state ?? "Implementation";
    if (state !== IDEATION && state !== "Implementation") {
      return yield* new InvalidChangeDraft({
        message: `a change is created as ${IDEATION} or Implementation, not ${state}`,
      });
    }
    const checkouts = (input.checkouts ?? [])
      .map((spec) => ({ ...spec, path: spec.path.trim() }))
      .filter((spec) => spec.path);
    for (const spec of checkouts) {
      const problem = checkoutSpecProblem(spec);
      if (problem) return yield* new InvalidChangeDraft({ message: problem });
    }
    if (state !== IDEATION && checkouts.length === 0) {
      return yield* new InvalidChangeDraft({ message: "select at least one repository" });
    }
    // Every repository is filed in the change directory under its own name, so two paths with the
    // same name would collide there — a worktree on top of a worktree, or two browse links.
    const duplicate = duplicateRepoNames(checkouts.map((spec) => spec.path));
    if (duplicate.length) {
      return yield* new InvalidChangeDraft({
        message:
          `two repositories share the name ${duplicate.join(", ")}: Corvi files each repository ` +
          `under its own name in the change directory`,
      });
    }
    const title = input.title?.trim();
    const change: Change = {
      id,
      branch: input.branch?.trim() || id,
      checkouts,
      extensions: input.extensions,
      // The context it was made in. Unknown means the first workspace, where every change
      // without one belongs.
      workspace: input.workspace?.trim() || undefined,
      // A name typed in the wizard is yours, so a ticket source never overwrites it later.
      ...(title ? { title, titleEdited: true } : {}),
      state,
      createdAt: new Date().toISOString(),
      formatVersion: FORMAT_VERSION,
    };
    yield* writeChange(change);
    return change;
  });
