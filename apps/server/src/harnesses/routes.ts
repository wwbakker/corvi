/** The Harnesses page's routes: the files the page edits, the resolved views beside them, and the
 * new-terminal dialog's harness window. */
import { isAbsolute } from "node:path";
import { Effect } from "effect";

import {
  HarnessFileRefSchema,
  HarnessFileWriteSchema,
  HarnessRepositoryFileRefSchema,
  HarnessRepositoryFileWriteSchema,
  OpenHarnessWindowSchema,
} from "@corvi/contracts/harnesses";
import { BadRequestError } from "@corvi/contracts/errors";
import { bodyAs, guard, json, queryAs, withChange } from "../capabilities/web.ts";
import { runtimeConfig } from "../workspace/server/index.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import {
  deleteHarnessFile,
  deleteRepositoryHarnessFile,
  harnessFiles,
  repositoryHarnessFiles,
  writeHarnessFile,
  writeRepositoryHarnessFile,
} from "./server/files.ts";
import { harnessListFor } from "./server/views.ts";
import { openHarnessWindow } from "./server/env.ts";
import { harnessChoices } from "./server/choices.ts";

export const harnessRoutes = guard({
  "/api/harnesses": {
    GET: (req) => {
      const params = new URL(req.url).searchParams;
      const workspace = params.get("workspace") ?? undefined;
      if (
        workspace !== undefined &&
        !runtimeConfig().workspaces.some((candidate) => candidate.id === workspace)
      ) {
        return runRoute(Effect.fail(new BadRequestError({ message: `no such workspace: ${workspace}` })));
      }
      const repositories = params.getAll("repository").filter((path) => path !== "");
      const trackedRepositories = params.getAll("trackedRepository").filter((path) => path !== "");
      // A repository the wizard names must be an absolute checkout path; a bare word would make a
      // key that launch discovery cannot resolve.
      if ([...repositories, ...trackedRepositories].some((path) => !isAbsolute(path))) {
        return runRoute(Effect.fail(new BadRequestError({ message: "repository must be an absolute path" })));
      }
      return runRoute(
        Effect.map(
          harnessChoices({
            ...(workspace === undefined ? {} : { workspace }),
            repositories,
            trackedRepositories,
          }),
          json,
        ),
      );
    },
  },

  "/api/harness-files": {
    GET: () => runRoute(Effect.map(harnessFiles(), json)),
    PUT: (req) =>
      runRoute(
        Effect.gen(function* () {
          return json(yield* writeHarnessFile(yield* bodyAs(req, HarnessFileWriteSchema)));
        }),
      ),
    DELETE: (req) =>
      runRoute(
        Effect.gen(function* () {
          const ref = yield* queryAs(req, HarnessFileRefSchema, "scope and id are required");
          return json(yield* deleteHarnessFile(ref));
        }),
      ),
  },

  "/api/changes/:id/harness-files": {
    GET: (req) => withChange(req.params.id, (change) => Effect.map(repositoryHarnessFiles(change), json)),
    PUT: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, HarnessRepositoryFileWriteSchema);
          return json(yield* writeRepositoryHarnessFile(change, body));
        }),
      ),
    DELETE: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const ref = yield* queryAs(req, HarnessRepositoryFileRefSchema, "repository and id are required");
          return json(yield* deleteRepositoryHarnessFile(change, ref));
        }),
      ),
  },

  "/api/changes/:id/harnesses": {
    GET: (req) =>
      withChange(req.params.id, (change) =>
        Effect.map(
          harnessListFor(change, {
            views: new URL(req.url).searchParams.get("views") !== "0",
          }),
          json,
        ),
      ),
  },

  "/api/changes/:id/harness-window": {
    POST: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, OpenHarnessWindowSchema);
          return json(yield* openHarnessWindow(change, body), 201);
        }),
      ),
  },
});
