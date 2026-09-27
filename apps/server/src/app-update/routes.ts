/**
 * The app-update routes: a transport adapter over apps/server/src/app-update/update.ts.
 *
 * Decode nothing (the requests carry no bodies), invoke the application operation, map its
 * refusals to the transport taxonomy, encode the status. `GET` is the cheap read a page polls;
 * `POST /api/app/update` starts the update and answers at once — 202 while it runs in the
 * background, 200 when there was nothing to do — and the journal is where a page watches it;
 * `POST /api/app/update/check` runs one check now rather than waiting for the schedule.
 */
import { Effect } from "effect";

import { BadRequestError, ConflictError, isIweError, type IweError } from "@corvi/contracts/errors";
import { layer as repositoriesLayer } from "@corvi/repositories/node";
import type { Repositories } from "@corvi/repositories";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard, json } from "../capabilities/web.ts";
import { messageOf } from "../capabilities/effect/support.ts";
import {
  startUpdate,
  updateStatus,
  checkUpdate,
  UpdateBusy,
  UpdateRefused,
  type AppUpdateOptions,
  type UpdateStart,
} from "./update.ts";

/** The one place an app-update refusal becomes an HTTP status: nothing to update is the caller's
 * business (400 with the reason the dialog shows), and a run already going is a conflict. */
const asIwe = (error: unknown): IweError => {
  if (error instanceof UpdateRefused) return new BadRequestError({ message: error.reason });
  if (error instanceof UpdateBusy) return new ConflictError({ message: error.reason });
  if (isIweError(error)) return error;
  return new BadRequestError({ message: messageOf(error) });
};

const respond = <A, E>(
  effect: Effect.Effect<A, E, Repositories>,
  encode: (value: A) => Response,
): Promise<Response> =>
  runRoute(
    effect.pipe(
      Effect.mapError(asIwe),
      Effect.map(encode),
      Effect.provide(repositoriesLayer),
    ),
  );

const encodeStart = (start: UpdateStart): Response =>
  json(start.status, start._tag === "Started" ? 202 : 200);

export const appUpdateRoutes = (options: AppUpdateOptions): ReturnType<typeof guard> =>
  guard({
    "/api/app/update": {
      GET: () => respond(updateStatus(options), json),
      POST: () => respond(startUpdate(options), encodeStart),
    },
    "/api/app/update/check": {
      POST: () => respond(checkUpdate(options), json),
    },
  });
