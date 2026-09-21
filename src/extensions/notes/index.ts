import { Effect, Schema } from "effect";
import {
  BadRequestError,
  DecodeError,
  NotFoundError,
} from "../../capabilities/effect/errors.ts";
import { Changes } from "../../integrations/api/capabilities.ts";
import type { IncludedIntegration } from "../../integrations/types.ts";
import type { Change } from "../../domain/change.ts";
import { bodyAs } from "../../capabilities/effect/body.ts";
import { readNotes, writeNotes } from "./server.ts";

/**
 * The notes extension: whatever you want to remember about a change, as a widget on its
 * dashboard.
 *
 * It contributes a dashboard widget (rendered by its client half) and the two routes that
 * widget reads and writes, under `/api/ext/notes/`. The notes themselves live in the
 * extension's own `ExtensionStore`, and a change whose notes predate the store still shows its
 * old sidecar through the `Changes.readSidecar` migration access — see ./server.ts.
 */

/** Find the change a route is about through the `Changes` capability, or answer 404. */
const withChange = <E, R>(
  id: string,
  effect: (change: Change) => Effect.Effect<Response, E, R>,
): Effect.Effect<Response, E | NotFoundError | DecodeError, R | Changes> =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    const change = yield* changes.read(id);
    if (!change) return yield* new NotFoundError({ message: `no such change: ${id}` });
    return yield* effect(change);
  });

export default {
  name: "notes",
  title: "Notes",

  // A client-drawn widget, not a server-drawn card: the textarea's debounce, unsaved marker
  // and never-overwrite-while-typing are client state a `Card.status` effect cannot hold. It
  // is a document, so it sits in the dashboard's left column beside the plan.
  dashboardWidgets: [{ id: "notes", title: "Notes", column: "left" }],

  routes: [
    {
      // The notes of a change: the extension's own file, or the legacy sidecar it was moved
      // from. The value is plain text, so it travels as JSON.
      method: "GET",
      path: "/changes/:id/notes",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.map(readNotes(change), (text) => Response.json({ text })),
        ),
    },
    {
      // Saving the notes. The write is always the extension's own file; the legacy sidecar is
      // read-only migration access and is never rewritten.
      method: "PUT",
      path: "/changes/:id/notes",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            const body = yield* bodyAs(req, Schema.Struct({ text: Schema.optional(Schema.String) }));
            const text = body.text ?? "";
            yield* writeNotes(change, text);
            return Response.json({ text });
          }),
        ),
    },
  ],
} satisfies IncludedIntegration;
