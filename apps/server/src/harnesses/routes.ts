/** The Harness profiles page's routes: the files the page edits, the resolved views beside
 * them, and the new-terminal dialog's harness window. */
import { isAbsolute } from "node:path";
import { Effect } from "effect";

import {
  HarnessProfileFileRefSchema,
  HarnessProfileFileWriteSchema,
  HarnessProfileRepositoryFileRefSchema,
  HarnessProfileRepositoryFileWriteSchema,
  OpenHarnessWindowSchema,
} from "@corvi/contracts/harness-profiles";
import { BadRequestError } from "@corvi/contracts/errors";
import { bodyAs, guard, json, queryAs, withChange } from "../capabilities/web.ts";
import { runtimeConfig } from "../workspace/server/index.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import {
  deleteHarnessProfileFile,
  deleteRepositoryHarnessProfileFile,
  harnessProfileFiles,
  repositoryHarnessProfileFiles,
  writeHarnessProfileFile,
  writeRepositoryHarnessProfileFile,
} from "./server/files.ts";
import { harnessProfilesFor } from "./server/views.ts";
import { openHarnessWindow } from "./server/env.ts";
import { listWindows } from "../terminals/server/index.ts";
import { harnessProfileChoices } from "./server/choices.ts";

export const harnessProfileRoutes = guard({
  "/api/harness-profiles": {
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
          harnessProfileChoices({
            ...(workspace === undefined ? {} : { workspace }),
            repositories,
            trackedRepositories,
          }),
          json,
        ),
      );
    },
  },

  "/api/harness-profile-files": {
    GET: () => runRoute(Effect.map(harnessProfileFiles(), json)),
    PUT: (req) =>
      runRoute(
        Effect.gen(function* () {
          return json(yield* writeHarnessProfileFile(yield* bodyAs(req, HarnessProfileFileWriteSchema)));
        }),
      ),
    DELETE: (req) =>
      runRoute(
        Effect.gen(function* () {
          const ref = yield* queryAs(req, HarnessProfileFileRefSchema, "scope and id are required");
          return json(yield* deleteHarnessProfileFile(ref));
        }),
      ),
  },

  "/api/changes/:id/harness-profile-files": {
    GET: (req) =>
      withChange(req.params.id, (change) => Effect.map(repositoryHarnessProfileFiles(change), json)),
    PUT: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, HarnessProfileRepositoryFileWriteSchema);
          return json(yield* writeRepositoryHarnessProfileFile(change, body));
        }),
      ),
    DELETE: (req) =>
      withChange(req.params.id, (change) =>
        Effect.gen(function* () {
          const ref = yield* queryAs(
            req,
            HarnessProfileRepositoryFileRefSchema,
            "repository and id are required",
          );
          return json(yield* deleteRepositoryHarnessProfileFile(change, ref));
        }),
      ),
  },

  "/api/changes/:id/harness-profiles": {
    GET: (req) =>
      withChange(req.params.id, (change) =>
        Effect.map(
          harnessProfilesFor(change, {
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
          const opened = yield* openHarnessWindow(change, body);
          // The answer is the change's windows, like every other create: the page applies it instead
          // of reading the list back, so there is no moment where it knows the change has nothing.
          const windows = yield* listWindows(change.id);
          return json({ ...opened, windows }, 201);
        }),
      ),
  },
});
