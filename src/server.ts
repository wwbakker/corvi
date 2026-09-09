import { basename, join } from "node:path";
import { Effect } from "effect";
import index from "./web/index.html";
import {
  applyPatch,
  createChangeEffect,
  listChangesEffect,
  readChangeEffect,
  readNotesEffect,
  writeChangeEffect,
  writeNotesEffect,
} from "./changes.ts";
import {
  cardByName,
  cardsFor,
  dispatchExtensionRoute,
  provisionEffect,
  repoStatusOfEffect,
  runCardEffect,
  statusOneEffect,
  wizardStepsFor,
} from "./extensions/index.ts";
import { absolutePath, browseEffect, remoteBranchesEffect } from "./repos.ts";
import { listLeftoversEffect, removeLeftoverEffect } from "./leftovers.ts";
import { summaryOfEffect } from "./summary.ts";
import { localChangesEffect, fileDiffEffect } from "./local.ts";
import { commitChangeEffect, pushChangeEffect, type CommitRequest } from "./commit.ts";
import { refreshTitlesEffect } from "./titles.ts";
import { deploymentsEffect, versionsForEffect, deployEffect } from "./deployments.ts";
import { proxyToTtyd, bridge, keysScript, type Bridge } from "./terminalProxy.ts";
import { platformName } from "./platform.ts";
import type { ServerWebSocket } from "bun";
import { repoStatesEffect, setReposEffect } from "./integrations/git.ts";
import { completeChangeEffect, completionOfEffect, progressOfEffect } from "./complete.ts";
import { cancelChangeEffect } from "./cancel.ts";
import { prDescriptionEffect } from "./description.ts";
import {
  allWindowsEffect,
  listWindowsEffect,
  newWindowEffect,
  selectWindowEffect,
  terminalPath,
  terminalPortEffect,
} from "./terminal.ts";
import { isFinished, type Change } from "./types.ts";
import { config } from "./config.ts";
import { loadCacheEffect, saveCacheEffect } from "./cache.ts";
import { settingsViewEffect, writeSettingsEffect, type Settings } from "./settings.ts";
import { workspaceById, workspaceOf } from "./workspaces.ts";
import { Workspace } from "./effect/tags.ts";
import { runRoute } from "./effect/run.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./effect/errors.ts";
import { announce, eventsEffect, watchState } from "./events.ts";
import { guard } from "./origin.ts";

// What the CLIs said last time. Restarting is normal — a config change, a crash, an edit while
// `bun --hot` is not enough — and without this every page waits for the CLIs all over again.
const restored = await Effect.runPromise(loadCacheEffect);

// Written now and then rather than on every entry: this is a cache, and losing the last minute
// of it costs one refresh.
setInterval(() => void Effect.runPromise(saveCacheEffect).catch(() => {}), 30_000).unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Effect.runPromise(saveCacheEffect)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/** A failure's message, the way `e instanceof Error ? e.message : String(e)` read it. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Which context the page is in. Sent by the browser, because that is where the choice lives —
 * two windows open on two clients is a reasonable thing to want. */
const workspaceParam = (req: Request): string | undefined =>
  new URL(req.url).searchParams.get("workspace") ?? undefined;

/** The request body, or a failure (a body that will not parse is the caller's mistake, which is
 * exactly what the old per-route `await req.json()` inside the try produced). */
const bodyOf = (req: Request): Effect.Effect<unknown, unknown> =>
  Effect.tryPromise({ try: () => req.json(), catch: (e) => e });

/** A body that is allowed to be absent or broken, read as `{}` — what `.catch(() => ({}))` did. */
const bodyOrEmpty = (req: Request): Effect.Effect<unknown> =>
  Effect.promise(() => req.json().catch(() => ({})));

/** A sync call that throws typed errors (applyPatch, resolveInRoot) lifted into the error
 * channel at the route boundary — where the old route's try/catch sat. */
const attempt = <A>(work: () => A): Effect.Effect<A, unknown> =>
  Effect.try({ try: work, catch: (e) => e });

/** Everything this request runs — every `gh`, `az`, `git` and Jira call, however deep — runs as
 * the workspace the change belongs to. The change says which; nothing has to be passed. */
const withChange = (
  id: string,
  effect: (change: Change) => Effect.Effect<Response, unknown>,
): Promise<Response> =>
  runRoute(
    Effect.flatMap(readChangeEffect(id), (change) => {
      if (!change) return Effect.fail(new NotFoundError({ message: `no such change: ${id}` }));
      return Effect.provideService(effect(change), Workspace, workspaceOf(change));
    }),
  );

/** The same, for the requests that are not about a change: the browser says which context it is
 * in, because that is where the choice lives. */
const withWorkspaceParam = (
  req: Request,
  effect: Effect.Effect<Response, unknown>,
): Promise<Response> =>
  runRoute(Effect.provideService(effect, Workspace, workspaceById(workspaceParam(req))));

/** ttyd's page and its socket, served from here: see src/terminalProxy.ts for why. */
const portForChange = (id: string): Promise<number | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const change = yield* readChangeEffect(id);
      return change && !change.completedAt ? yield* terminalPortEffect(change) : undefined;
    }),
  );

const server = Bun.serve({
  // 4000 while developing; the app picks a fresh port at each launch, so the two never meet —
  // and nothing stale on a fixed port is ever mistaken for the app's server.
  port: Number(process.env.IWE_PORT ?? 4000),
  // Localhost only: the server acts as you, using your CLI credentials, so it has no auth of its own.
  hostname: "127.0.0.1",
  // The event stream is quiet by nature, and Bun closes an idle connection after ten seconds —
  // which the browser survives by reconnecting, noisily, six times a minute, for ever. The
  // stream sends a heartbeat as well; this is the belt to that pair of braces.
  idleTimeout: 120,
  development: process.env.NODE_ENV !== "production",
  // Typed here rather than on Bun.serve: naming the socket's data type there would take the
  // route handlers' own inference with it.
  websocket: {
    open: (ws) => bridge.open(ws as unknown as ServerWebSocket<Bridge>),
    message: (ws, message) => bridge.message(ws as unknown as ServerWebSocket<Bridge>, message),
    close: (ws) => bridge.close(ws as unknown as ServerWebSocket<Bridge>),
  },

  routes: guard({
    // ttyd, served from here so the page and the terminal share an origin. Both the page and
    // its WebSocket come through this one route.
    "/terminal/:id/*": async (req, srv) => {
      const id = decodeURIComponent(req.params.id);
      const port = await portForChange(id);
      if (!port) return new Response("no terminal for this change", { status: 404 });
      if (req.headers.get("upgrade") === "websocket") {
        const data: Bridge = { queue: [], port };
        return srv.upgrade(req, { data: data as never })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const rest = new URL(req.url).pathname.slice(`/terminal/${req.params.id}/`.length);
      return proxyToTtyd(req, port, rest);
    },

    "/terminal-keys.js": () =>
      new Response(keysScript(platformName), {
        headers: { "content-type": "text/javascript" },
      }),

    "/api/changes": {
      GET: () => runRoute(Effect.map(listChangesEffect(), json)),
      // Creates the change, then provisions each component (worktrees, ticket status). The
      // change is written first, so a failing component leaves something to fix, not nothing.
      POST: (req) =>
        runRoute(
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as Parameters<typeof createChangeEffect>[0];
            const change = yield* createChangeEffect(body);
            const provision = yield* Effect.provideService(
              provisionEffect(change),
              Workspace,
              workspaceOf(change),
            );
            // Your own action lands on the stream at once, not within a tick.
            yield* Effect.sync(() => announce("changes"));
            return json({ change, provision }, 201);
          }),
        ),
    },

    // One connection that says when something changed, so no page has to keep asking. What is
    // pushed is the news, never the data: a page that hears "changes" asks for them.
    "/api/events": {
      GET: (req) => runRoute(eventsEffect(req)),
    },

    // Whether the server is watching, and for how many pages. For the tests: nothing in the UI
    // asks, and nothing should.
    "/api/events/listeners": {
      GET: () => json(watchState()),
    },

    // The steps the "Create change" wizard has in the context you are in: the extensions'
    // contributions, resolved per workspace. The page renders what it is told exists — which is
    // why a context without an extension has no step to show for it, not an empty one.
    "/api/wizard": {
      GET: (req) =>
        withWorkspaceParam(
          req,
          Effect.succeed(json({ steps: wizardStepsFor(workspaceById(workspaceParam(req))) })),
        ),
    },

    // Extension routes: whatever the extensions registered, under one namespace, with the same
    // origin guard as the rest and the workspace the request names. Unknown routes 404.
    "/api/ext/:name/:path": async (req) =>
      (await dispatchExtensionRoute(req)) ?? new Response("no such extension route", { status: 404 }),

    // Every change's terminals, in one call: the navigation column lists them all, and asking
    // per change would be a process per change every few seconds. A timed-out tmux is no news,
    // not a failed request — what the old facade swallowed, kept explicitly.
    "/api/terminals": {
      GET: () =>
        runRoute(
          Effect.map(
            Effect.catchAll(allWindowsEffect(), () => Effect.succeed({})),
            json,
          ),
        ),
    },

    // The contexts you switch between: a client, your own projects. Configured, not discovered.
    // The response also carries the platform, once, at page bootstrap: the only place the UI
    // learns which key hints to draw. It is the server's platform — the shell the terminal
    // serves lives on this machine, so its conventions are the ones the page should hint at.
    "/api/workspaces": {
      GET: () => json({ workspaces: config.workspaces, platform: platformName }),
    },

    // The settings file, read and written from the page. Writing puts them into effect at once:
    // the config object every module holds is refilled rather than replaced.
    "/api/settings": {
      GET: () => runRoute(Effect.map(settingsViewEffect, json)),
      PUT: (req) =>
        runRoute(
          Effect.gen(function* () {
            return json(yield* writeSettingsEffect((yield* bodyOf(req)) as Settings));
          }),
        ),
    },

    // What is deployed where. Not about a change: a service's build goes to an environment, and
    // which change produced it is a separate question.
    // Scoped to the context you are in: a second client is a second organisation, and its
    // pipelines are not this one's.
    "/api/deployments": {
      GET: (req) =>
        withWorkspaceParam(
          req,
          Effect.map(deploymentsEffect(workspaceParam(req)), json),
        ),
    },

    // The versions a service has built and could be given, newest first.
    "/api/deployments/:service/versions": {
      GET: (req) =>
        withWorkspaceParam(
          req,
          Effect.map(versionsForEffect(req.params.service, workspaceParam(req)), json),
        ),
    },

    // The one irreversible thing on that page: start a deploy.
    "/api/deployments/:service/deploy": {
      POST: (req) =>
        withWorkspaceParam(
          req,
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as { version?: string; environment?: string };
            if (!body.version || !body.environment) {
              return yield* Effect.fail(
                new BadRequestError({ message: "version and environment required" }),
              );
            }
            return json(
              yield* deployEffect(req.params.service, body.version, body.environment, workspaceParam(req)),
            );
          }),
        ),
    },

    // What each change is called, refreshed from Jira in one query for the whole page. Its own
    // route, and not part of /api/changes: the list must stay instant, this waits for a CLI.
    "/api/titles": {
      GET: () => runRoute(Effect.map(refreshTitlesEffect(), json)),
    },

    // The components this change's dashboard shows: the ones its workspace has at all. The
    // browser asks each of them for its own widget, so one slow CLI cannot hold up the page.
    "/api/changes/:id/integrations": {
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.succeed(
            json(
              cardsFor(c).map(({ name, card }) => ({
                name,
                title: card.title,
                // Per-repository components are fetched a repository at a time by the browser.
                perRepo: Boolean(card.repoStatus),
                wide: Boolean(card.wide),
              })),
            ),
          ),
        ),
    },

    "/api/changes/:id": {
      // Just the change: instant, no CLI calls, so the header renders immediately.
      GET: (req) => withChange(req.params.id, (c) => Effect.succeed(json(c))),
      // Only the fields you can edit by hand — its state and its name. Repositories have their
      // own endpoint, and the rest is either derived or the change's identity.
      PATCH: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as { state?: string; title?: string };
            const updated = yield* attempt(() => applyPatch(c, body));
            yield* writeChangeEffect(updated);
            yield* Effect.sync(() => announce("changes"));
            return json(updated);
          }),
        ),
    },

    // The repository list of a change, edited as a whole: the dialog sends the list it wants.
    "/api/changes/:id/repos": {
      GET: (req) =>
        withChange(req.params.id, (c) => Effect.map(repoStatesEffect(c), json)),
      POST: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as {
              repos: string[];
              direct?: string[];
              base?: Record<string, string>;
              force?: boolean;
            };
            const result = yield* setReposEffect(c, body.repos, body.force, body.direct, body.base);
            // 409: nothing was changed, the browser should ask about the unpushed work first.
            return result._tag === "NeedsForce"
              ? json({ needsForce: result.needsForce }, 409)
              : json(result.change);
          }),
        ),
    },

    // The three numbers a change's card on the overview shows. One request per card, so a
    // change whose CLIs are slow holds up only its own card.
    "/api/changes/:id/summary": {
      GET: (req) => withChange(req.params.id, (c) => Effect.map(summaryOfEffect(c), json)),
    },

    // What is uncommitted in one repository, and the diff of one file of it. Live: this is the
    // work you are doing, and a cached answer would be a wrong one.
    "/api/changes/:id/local": {
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const repo = new URL(req.url).searchParams.get("path");
            if (!repo) {
              return yield* Effect.fail(new BadRequestError({ message: "path required" }));
            }
            return json(yield* localChangesEffect(c, repo));
          }),
        ),
    },

    // One commit per repository, with the same message: a change is one piece of work.
    "/api/changes/:id/commit": {
      POST: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            return json(yield* commitChangeEffect(c, (yield* bodyOf(req)) as CommitRequest));
          }),
        ),
    },

    // Pushing what is committed, in the repositories that have something to push.
    "/api/changes/:id/push": {
      POST: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as { repos?: string[] };
            return json(yield* pushChangeEffect(c, body.repos ?? c.repos));
          }),
        ),
    },

    "/api/changes/:id/local/diff": {
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const params = new URL(req.url).searchParams;
            const repo = params.get("path");
            const file = params.get("file");
            if (!repo || !file) {
              return yield* Effect.fail(new BadRequestError({ message: "path and file required" }));
            }
            return json({ text: yield* fileDiffEffect(c, repo, file, params.get("staged") === "1") });
          }),
        ),
    },

    // Whatever you want to remember about this change; plain text in the change directory.
    "/api/changes/:id/notes": {
      GET: (req) =>
        withChange(req.params.id, (c) => Effect.map(readNotesEffect(c.id), (text) => json({ text }))),
      PUT: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as { text?: string };
            yield* writeNotesEffect(c.id, body.text ?? "");
            return json({ text: body.text ?? "" });
          }),
        ),
    },

    // The change's terminal: a tmux session in the change directory, served by ttyd. Starting
    // it is what asking for the URL does.
    "/api/changes/:id/terminal": {
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            yield* terminalPortEffect(c); // starts or adopts it, so the frame has something to load
            return json({ url: terminalPath(c.id) });
          }),
        ),
    },

    // The windows of the change's tmux session, and the two things you do to them. tmux is the
    // source of truth: this only reads and pokes it. A timed-out tmux is an empty strip, not a
    // failed request — what the old facade swallowed, kept explicitly.
    "/api/changes/:id/terminal/windows": {
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.map(
            Effect.catchAll(listWindowsEffect(c.id), () => Effect.succeed([])),
            json,
          ),
        ),
      POST: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as { action: "new" | "select"; index?: number };
            if (body.action === "new") yield* newWindowEffect(c.id);
            else if (body.action === "select") yield* selectWindowEffect(c.id, body.index ?? 0);
            else {
              return yield* Effect.fail(
                new BadRequestError({ message: `unknown window action: ${body.action}` }),
              );
            }
            return json(yield* listWindowsEffect(c.id));
          }),
        ),
    },

    // Text for a pull request, built here because the ticket summary comes from the Jira CLI.
    "/api/changes/:id/description": {
      GET: (req) =>
        withChange(req.params.id, (c) => Effect.map(prDescriptionEffect(c), (text) => json({ text }))),
    },

    // Completing a change: merge every outstanding pull request and close the ticket. GET
    // reports whether that is currently allowed, so the button can explain itself.
    // How far a completion got: written as it happens, so this answers even after a restart.
    "/api/changes/:id/complete/progress": {
      GET: (req) => withChange(req.params.id, (c) => Effect.map(progressOfEffect(c.id), json)),
    },

    // Abandoning a change: the worktrees and the terminal go, and everything anyone else can
    // see — branches, pull requests, the ticket — is left alone and reported back.
    "/api/changes/:id/cancel": {
      POST: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const body = (yield* bodyOrEmpty(req)) as { force?: boolean };
            const result = yield* cancelChangeEffect(c, body.force === true);
            // The same protocol a repository removal uses: ask once, then repeat with force.
            return result._tag === "NeedsForce"
              ? json({ needsForce: result.needsForce }, 409)
              : json({ change: result.change, loose: result.loose });
          }),
        ),
    },

    "/api/changes/:id/complete": {
      // Whether it could be completed, for the menu item. A readiness check that cannot be made
      // — no GitHub remote, `gh` not logged in — is a reason it is not ready rather than a failed
      // request: the page swallowed the error and disabled the item with nothing to say, which
      // is the least useful of the three possible outcomes.
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.catchAll(
            Effect.map(completionOfEffect(c), json),
            (e) => Effect.succeed(json({ ready: false, reasons: [messageOf(e)], toMerge: [] })),
          ),
        ),
      POST: (req) =>
        withChange(req.params.id, (c) => Effect.map(completeChangeEffect(c), json)),
    },

    // One repository's rows of one component, so a change with many repositories fills in
    // one by one rather than all at once at the end.
    "/api/changes/:id/:integration/repo": {
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const card = cardByName(req.params.integration);
            const repo = new URL(req.url).searchParams.get("path");
            if (!card) {
              return yield* Effect.fail(new NotFoundError({ message: "unknown integration" }));
            }
            if (!repo) {
              return yield* Effect.fail(new BadRequestError({ message: "path required" }));
            }
            return json({ items: yield* repoStatusOfEffect(card, c, repo) });
          }),
        ),
    },

    // One integration's widget, fetched and refreshed independently by the browser.
    "/api/changes/:id/:integration": {
      GET: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const card = cardByName(req.params.integration);
            if (!card) {
              return yield* Effect.fail(new NotFoundError({ message: "unknown integration" }));
            }
            return json(yield* statusOneEffect(req.params.integration, card, c));
          }),
        ),
    },

    "/api/changes/:id/:integration/:action": {
      POST: (req) =>
        withChange(req.params.id, (c) =>
          Effect.gen(function* () {
            const card = cardByName(req.params.integration);
            if (!card) {
              return yield* Effect.fail(new NotFoundError({ message: "unknown integration" }));
            }
            // The buttons are gone from a finished change's dashboard, but the page may have been
            // open since before it was finished — and this is where the truth lives.
            if (isFinished(c)) {
              return yield* Effect.fail(new ConflictError({ message: `${c.id} is finished` }));
            }
            const body = (yield* bodyOrEmpty(req)) as { arg?: string };
            yield* runCardEffect(card, c, req.params.action, body.arg);
            // Per-repository components answer with the rows of the repository acted on; the
            // argument of every such action is that repository.
            if (card.repoStatus && body.arg) {
              return json({ items: yield* repoStatusOfEffect(card, c, body.arg) });
            }
            return json(yield* statusOneEffect(req.params.integration, card, c));
          }),
        ),
    },

    // Directories left in the changes root by changes that are done: shown, never removed on
    // your behalf.
    "/api/leftovers": {
      GET: () => runRoute(Effect.map(listLeftoversEffect, json)),
    },
    "/api/leftovers/:name": {
      DELETE: (req) =>
        runRoute(
          Effect.gen(function* () {
            yield* removeLeftoverEffect(req.params.name);
            return json(yield* listLeftoversEffect);
          }),
        ),
    },

    // Directory browser rooted at the configured repos root; paths that escape it are rejected.
    "/api/repos": {
      GET: (req) =>
        runRoute(
          Effect.gen(function* () {
            // No path parameter at all: open where the configuration says. An explicit empty
            // one is the root, which is how "up" out of the starting directory works.
            return json(yield* browseEffect(new URL(req.url).searchParams.get("path") ?? undefined));
          }),
        ),
    },

    // Branches a new worktree can start from, for the base selector.
    "/api/repos/branches": {
      GET: (req) =>
        runRoute(
          Effect.gen(function* () {
            const path = new URL(req.url).searchParams.get("path") ?? "";
            // Absolute paths come from the change itself; relative ones from the browser.
            const repo = yield* attempt(() => (path.startsWith("/") ? path : absolutePath(path)));
            return json(yield* remoteBranchesEffect(repo));
          }),
        ),
    },

    // The manifest is bundled with the page; its icons are plain files served from here.
    "/icons/:file": async (req) => {
      // basename: the parameter must not walk out of the icons directory.
      const file = Bun.file(join("src/web/icons", basename(req.params.file)));
      return (await file.exists()) ? new Response(file) : new Response("no such icon", { status: 404 });
    },

    "/*": index,
  }),
});

console.log(`iwe on ${server.url}${restored ? ` (${restored} cached answers restored)` : ""}`);

// The page is built on demand, and a failed build in production comes back as an empty 200 with
// no error anywhere — in the app's window that is a black screen, with nothing to say why. Ask
// for the page once at startup, where the answer is visible: a server whose page cannot build
// stops here (the window then reports it and points at this log) instead of blinding one.
{
  const page = await fetch(`${server.url}`).then((r) => r.text()).catch(() => "");
  if (!page.includes("<!doctype html>") || page.includes("Build Failed")) {
    console.error(
      `the page did not build — ${server.url} served ${page.length} bytes that are not the app`,
    );
    console.error(
      "usually dependencies: run `bun install`. For the full error: bun build src/web/index.html --outdir /tmp/iwe-check --production",
    );
    process.exit(1);
  }
}
