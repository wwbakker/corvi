import { basename } from "node:path";
import { Effect } from "effect";
import { IDEATION, type Change, type ChangeDraft } from "../../domain/change.ts";
import { BadRequestError, ConflictError, DecodeError } from "../../capabilities/effect/errors.ts";
import { readChange, writeChange, writeWtConfig } from "./store.ts";

/** The core's creation input: the plain draft the wizard collected and the `change:creating`
 * hooks transformed. */
export type CreateChangeInput = ChangeDraft;

/** Create a change from an already-transformed draft. Every invariant is re-checked here — the
 * id shape, the repository list, the starting state — so a hook's patch is applied by the
 * caller and then validated by the core before anything is written: an extension may suggest,
 * never bypass. */
export const createChange = (
  input: CreateChangeInput,
): Effect.Effect<Change, BadRequestError | ConflictError | DecodeError> =>
  Effect.gen(function* () {
    const id = input.id.trim();
    if (!id || id !== basename(id) || id.startsWith(".")) {
      return yield* new BadRequestError({ message: `invalid change id: ${input.id}` });
    }
    if (yield* readChange(id)) {
      return yield* new ConflictError({ message: `change already exists: ${id}` });
    }
    // Two creation states: an idea, which needs nothing but a plan, and a change created ready
    // to work, which needs somewhere to work. A finished state is not something you create into.
    const state = input.state ?? "In Progress";
    if (state !== IDEATION && state !== "In Progress") {
      return yield* new BadRequestError({
        message: `a change is created as ${IDEATION} or In Progress, not ${state}`,
      });
    }
    const repos = (input.repos ?? []).map((r) => r.trim()).filter(Boolean);
    if (state !== IDEATION && repos.length === 0) {
      return yield* new BadRequestError({ message: "select at least one repository" });
    }
    const title = input.title?.trim();
    const change: Change = {
      id,
      branch: input.branch?.trim() || id,
      repos,
      direct: input.direct?.filter((r) => repos.includes(r)),
      base: input.base,
      extensions: input.extensions,
      // The context it was made in. Unknown means the first workspace, where every change
      // without one belongs.
      workspace: input.workspace?.trim() || undefined,
      // A name typed in the wizard is yours, so a ticket source never overwrites it later.
      ...(title ? { title, titleEdited: true } : {}),
      state,
      createdAt: new Date().toISOString(),
    };
    yield* writeChange(change);
    yield* writeWtConfig(id);
    return change;
  });
