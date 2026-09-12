import { basename } from "node:path";
import { Effect } from "effect";
import type { Change, ChangeDraft } from "../../domain/change.ts";
import { BadRequestError, ConflictError, DecodeError } from "../../capabilities/effect/errors.ts";
import { readChange, writeChange, writeWtConfig } from "./store.ts";

/** The core's creation input: the plain draft the wizard collected and the `change:creating`
 * hooks transformed. */
export type CreateChangeInput = ChangeDraft;

/** Create a change from an already-transformed draft. Every invariant is re-checked here — the
 * id shape, the non-empty repository list, the starting state — so a hook's patch is applied
 * by the caller and then validated by the core before anything is written: an extension may
 * suggest, never bypass. */
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
    const repos = (input.repos ?? []).map((r) => r.trim()).filter(Boolean);
    if (repos.length === 0) {
      return yield* new BadRequestError({ message: "select at least one repository" });
    }
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
      state: "In Progress",
      createdAt: new Date().toISOString(),
    };
    yield* writeChange(change);
    yield* writeWtConfig(id);
    return change;
  });
