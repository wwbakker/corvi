import { basename, join } from "node:path";
import index from "./web/index.html";
import {
  listChanges,
  readChange,
  writeChange,
  createChange,
  applyPatch,
  readNotes,
  writeNotes,
} from "./changes.ts";
import { integrations, integrationsFor, provision, repoStatusOf, statusOne } from "./integrations/index.ts";
import { boardIssues, createIssue } from "./integrations/jira.ts";
import { browse, remoteBranches, absolutePath } from "./repos.ts";
import { listLeftovers, removeLeftover } from "./leftovers.ts";
import { summaryOf } from "./summary.ts";
import { localChanges, fileDiff } from "./local.ts";
import { commitChange, pushChange, type CommitRequest } from "./commit.ts";
import { refreshTitles } from "./titles.ts";
import { deployments, versionsFor, deploy } from "./deployments.ts";
import { proxyToTtyd, bridge, keysScript, type Bridge } from "./terminalProxy.ts";
import { platformName } from "./platform.ts";
import type { ServerWebSocket } from "bun";
import { repoStates, setRepos } from "./integrations/git.ts";
import { completeChange, completionOf, progressOf } from "./complete.ts";
import { cancelChange } from "./cancel.ts";
import { prDescription } from "./description.ts";
import {
  terminalPath,
  terminalPort,
  listWindows,
  allWindows,
  newWindow,
  selectWindow,
} from "./terminal.ts";
import { CHANGE_STATES, isFinished, type Change, type ChangeState } from "./types.ts";
import { config } from "./config.ts";
import { settingsView, writeSettings, type Settings } from "./settings.ts";
import { withWorkspace } from "./context.ts";
import { workspaceById, workspaceOf } from "./workspaces.ts";
import { loadCache, saveCache } from "./cache.ts";
import { announce, events, watchState } from "./events.ts";
import { guard } from "./origin.ts";

// What the CLIs said last time. Restarting is normal — a config change, a crash, an edit while
// `bun --hot` is not enough — and without this every page waits for the CLIs all over again.
const restored = await loadCache();

// Written now and then rather than on every entry: this is a cache, and losing the last minute
// of it costs one refresh.
setInterval(() => void saveCache().catch(() => {}), 30_000).unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void saveCache()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/** Which context the page is in. Sent by the browser, because that is where the choice lives —
 * two windows open on two clients is a reasonable thing to want. */
const workspaceParam = (req: Request): string | undefined =>
  new URL(req.url).searchParams.get("workspace") ?? undefined;

const fail = (e: unknown): Response =>
  json({ error: e instanceof Error ? e.message : String(e) }, 400);

async function withChange(id: string, fn: (c: Change) => Promise<Response>): Promise<Response> {
  const change = await readChange(id);
  if (!change) return json({ error: `no such change: ${id}` }, 404);
  // Everything this request runs — every `gh`, `az`, `git` and Jira call, however deep — runs as
  // the workspace the change belongs to. The change says which; nothing has to be passed.
  return withWorkspace(workspaceOf(change), async () => {
    try {
      return await fn(change);
    } catch (e) {
      return fail(e);
    }
  });
}

/** The same, for the requests that are not about a change: the browser says which context it is
 * in, because that is where the choice lives. */
function withWorkspaceParam(req: Request, fn: () => Promise<Response>): Promise<Response> {
  return withWorkspace(workspaceById(workspaceParam(req)), fn);
}

/** ttyd's page and its socket, served from here: see src/terminalProxy.ts for why. */
async function portForChange(id: string): Promise<number | undefined> {
  const change = await readChange(id);
  return change && !change.completedAt ? terminalPort(change) : undefined;
}

const server = Bun.serve({
  // 4000 while developing; the app installs itself on a port of its own, so the two never meet.
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
      GET: async () => json(await listChanges()),
      // Creates the change, then provisions each component (worktrees, ticket status). The
      // change is written first, so a failing component leaves something to fix, not nothing.
      POST: async (req) => {
        try {
          const change = await createChange(
            (await req.json()) as Parameters<typeof createChange>[0],
          );
          return withWorkspace(workspaceOf(change), async () => {
            const result = json({ change, provision: await provision(change) }, 201);
            announce("changes");
            return result;
          });
        } catch (e) {
          return fail(e);
        }
      },
    },

    // One connection that says when something changed, so no page has to keep asking. What is
    // pushed is the news, never the data: a page that hears "changes" asks for them.
    "/api/events": {
      GET: (req) => events(req),
    },

    // Whether the server is watching, and for how many pages. For the tests: nothing in the UI
    // asks, and nothing should.
    "/api/events/listeners": {
      GET: () => json(watchState()),
    },

    // Every change's terminals, in one call: the navigation column lists them all, and asking
    // per change would be a process per change every few seconds.
    "/api/terminals": {
      GET: async () => json(await allWindows()),
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
      GET: () => json(settingsView()),
      PUT: async (req) => {
        try {
          return json(await writeSettings((await req.json()) as Settings));
        } catch (e) {
          return fail(e);
        }
      },
    },

    // What is deployed where. Not about a change: a service's build goes to an environment, and
    // which change produced it is a separate question.
    // Scoped to the context you are in: a second client is a second organisation, and its
    // pipelines are not this one's.
    "/api/deployments": {
      GET: async (req) =>
        withWorkspaceParam(req, async () => json(await deployments(workspaceParam(req)))),
    },

    // The versions a service has built and could be given, newest first.
    "/api/deployments/:service/versions": {
      GET: async (req) =>
        withWorkspaceParam(req, async () => {
          try {
            return json(await versionsFor(req.params.service, workspaceParam(req)));
          } catch (e) {
            return fail(e);
          }
        }),
    },

    // The one irreversible thing on that page: start a deploy.
    "/api/deployments/:service/deploy": {
      POST: async (req) =>
        withWorkspaceParam(req, async () => {
          try {
            const body = (await req.json()) as { version?: string; environment?: string };
            if (!body.version || !body.environment) {
              return json({ error: "version and environment required" }, 400);
            }
            return json(
              await deploy(req.params.service, body.version, body.environment, workspaceParam(req)),
            );
          } catch (e) {
            return fail(e);
          }
        }),
    },

    // What each change is called, refreshed from Jira in one query for the whole page. Its own
    // route, and not part of /api/changes: the list must stay instant, this waits for a CLI.
    "/api/titles": {
      GET: async () => json(await refreshTitles()),
    },

    // The components this change's dashboard shows: the ones its workspace has at all. The
    // browser asks each of them for its own widget, so one slow CLI cannot hold up the page.
    "/api/changes/:id/integrations": {
      GET: async (req) =>
        withChange(req.params.id, async (c) =>
          json(
            integrationsFor(c).map((i) => ({
              name: i.name,
              title: i.title,
              // Per-repository components are fetched a repository at a time by the browser.
              perRepo: Boolean(i.repoStatus),
              wide: Boolean(i.wide),
            })),
          ),
        ),
    },

    "/api/changes/:id": {
      // Just the change: instant, no CLI calls, so the header renders immediately.
      GET: async (req) => withChange(req.params.id, async (c) => json(c)),
      // Only the fields you can edit by hand — its state and its name. Repositories have their
      // own endpoint, and the rest is either derived or the change's identity.
      PATCH: async (req) =>
        withChange(req.params.id, async (c) => {
          try {
            const updated = applyPatch(c, (await req.json()) as { state?: string; title?: string });
            await writeChange(updated);
            announce("changes");
            return json(updated);
          } catch (e) {
            return fail(e);
          }
        }),
    },

    // The repository list of a change, edited as a whole: the dialog sends the list it wants.
    "/api/changes/:id/repos": {
      GET: async (req) => withChange(req.params.id, async (c) => json(await repoStates(c))),
      POST: async (req) =>
        withChange(req.params.id, async (c) => {
          const body = (await req.json()) as {
            repos: string[];
            direct?: string[];
            base?: Record<string, string>;
            force?: boolean;
          };
          const result = await setRepos(c, body.repos, body.force, body.direct, body.base);
          // 409: nothing was changed, the browser should ask about the unpushed work first.
          return "needsForce" in result ? json(result, 409) : json(result.change);
        }),
    },

    // The three numbers a change's card on the overview shows. One request per card, so a
    // change whose CLIs are slow holds up only its own card.
    "/api/changes/:id/summary": {
      GET: async (req) => withChange(req.params.id, async (c) => json(await summaryOf(c))),
    },

    // What is uncommitted in one repository, and the diff of one file of it. Live: this is the
    // work you are doing, and a cached answer would be a wrong one.
    "/api/changes/:id/local": {
      GET: async (req) =>
        withChange(req.params.id, async (c) => {
          const repo = new URL(req.url).searchParams.get("path");
          if (!repo) return json({ error: "path required" }, 400);
          return json(await localChanges(c, repo));
        }),
    },

    // One commit per repository, with the same message: a change is one piece of work.
    "/api/changes/:id/commit": {
      POST: async (req) =>
        withChange(req.params.id, async (c) => {
          try {
            return json(await commitChange(c, (await req.json()) as CommitRequest));
          } catch (e) {
            return fail(e);
          }
        }),
    },

    // Pushing what is committed, in the repositories that have something to push.
    "/api/changes/:id/push": {
      POST: async (req) =>
        withChange(req.params.id, async (c) => {
          try {
            const body = (await req.json()) as { repos?: string[] };
            return json(await pushChange(c, body.repos ?? c.repos));
          } catch (e) {
            return fail(e);
          }
        }),
    },

    "/api/changes/:id/local/diff": {
      GET: async (req) =>
        withChange(req.params.id, async (c) => {
          const params = new URL(req.url).searchParams;
          const repo = params.get("path");
          const file = params.get("file");
          if (!repo || !file) return json({ error: "path and file required" }, 400);
          try {
            return json({ text: await fileDiff(c, repo, file, params.get("staged") === "1") });
          } catch (e) {
            return fail(e);
          }
        }),
    },

    // Whatever you want to remember about this change; plain text in the change directory.
    "/api/changes/:id/notes": {
      GET: async (req) => withChange(req.params.id, async (c) => json({ text: await readNotes(c.id) })),
      PUT: async (req) =>
        withChange(req.params.id, async (c) => {
          const body = (await req.json()) as { text?: string };
          await writeNotes(c.id, body.text ?? "");
          return json({ text: body.text ?? "" });
        }),
    },

    // The change's terminal: a tmux session in the change directory, served by ttyd. Starting
    // it is what asking for the URL does.
    "/api/changes/:id/terminal": {
      GET: async (req) =>
        withChange(req.params.id, async (c) => {
          await terminalPort(c); // starts or adopts it, so the frame has something to load
          return json({ url: terminalPath(c.id) });
        }),
    },

    // The windows of the change's tmux session, and the two things you do to them. tmux is the
    // source of truth: this only reads and pokes it.
    "/api/changes/:id/terminal/windows": {
      GET: async (req) => withChange(req.params.id, async (c) => json(await listWindows(c.id))),
      POST: async (req) =>
        withChange(req.params.id, async (c) => {
          const body = (await req.json()) as { action: "new" | "select"; index?: number };
          if (body.action === "new") await newWindow(c.id);
          else if (body.action === "select") await selectWindow(c.id, body.index ?? 0);
          else throw new Error(`unknown window action: ${body.action}`);
          return json(await listWindows(c.id));
        }),
    },

    // Text for a pull request, built here because the ticket summary comes from the Jira CLI.
    "/api/changes/:id/description": {
      GET: async (req) =>
        withChange(req.params.id, async (c) => json({ text: await prDescription(c) })),
    },

    // Completing a change: merge every outstanding pull request and close the ticket. GET
    // reports whether that is currently allowed, so the button can explain itself.
    // How far a completion got: written as it happens, so this answers even after a restart.
    "/api/changes/:id/complete/progress": {
      GET: async (req) => withChange(req.params.id, async (c) => json(await progressOf(c.id))),
    },

    // Abandoning a change: the worktrees and the terminal go, and everything anyone else can
    // see — branches, pull requests, the ticket — is left alone and reported back.
    "/api/changes/:id/cancel": {
      POST: async (req) =>
        withChange(req.params.id, async (c) => {
          const body = (await req.json().catch(() => ({}))) as { force?: boolean };
          const result = await cancelChange(c, body.force === true);
          // The same protocol a repository removal uses: ask once, then repeat with force.
          return "needsForce" in result ? json(result, 409) : json(result);
        }),
    },

    "/api/changes/:id/complete": {
      // Whether it could be completed, for the menu item. A readiness check that cannot be made
      // — no GitHub remote, `gh` not logged in — is a reason it is not ready rather than a failed
      // request: the page swallowed the error and disabled the item with nothing to say, which
      // is the least useful of the three possible outcomes.
      GET: async (req) =>
        withChange(req.params.id, async (c) =>
          json(
            await completionOf(c).catch((e: unknown) => ({
              ready: false,
              reasons: [e instanceof Error ? e.message : String(e)],
              toMerge: [],
            })),
          ),
        ),
      POST: async (req) => withChange(req.params.id, async (c) => json(await completeChange(c))),
    },

    // One repository's rows of one component, so a change with many repositories fills in
    // one by one rather than all at once at the end.
    "/api/changes/:id/:integration/repo": {
      GET: async (req) =>
        withChange(req.params.id, async (c) => {
          const integration = integrations[req.params.integration];
          const repo = new URL(req.url).searchParams.get("path");
          if (!integration) return json({ error: "unknown integration" }, 404);
          if (!repo) return json({ error: "path required" }, 400);
          return json({ items: await repoStatusOf(integration, c, repo) });
        }),
    },

    // One integration's widget, fetched and refreshed independently by the browser.
    "/api/changes/:id/:integration": {
      GET: async (req) =>
        withChange(req.params.id, async (c) => {
          const integration = integrations[req.params.integration];
          if (!integration) return json({ error: "unknown integration" }, 404);
          return json(await statusOne(integration, c));
        }),
    },

    "/api/changes/:id/:integration/:action": {
      POST: async (req) =>
        withChange(req.params.id, async (c) => {
          const integration = integrations[req.params.integration];
          if (!integration?.run) return json({ error: "unknown integration" }, 404);
          // The buttons are gone from a finished change's dashboard, but the page may have been
          // open since before it was finished — and this is where the truth lives.
          if (isFinished(c)) return json({ error: `${c.id} is finished` }, 409);
          const body = (await req.json().catch(() => ({}))) as { arg?: string };
          await integration.run(c, req.params.action, body.arg);
          // Per-repository components answer with the rows of the repository acted on; the
          // argument of every such action is that repository.
          if (integration.repoStatus && body.arg) {
            return json({ items: await repoStatusOf(integration, c, body.arg) });
          }
          return json(await statusOne(integration, c));
        }),
    },

    // Feeds the change wizard. Returns an error string rather than a failure status: a broken
    // or unconfigured Jira must still leave you able to type a change id by hand.
    "/api/jira/issues": {
      GET: async (req) =>
        withWorkspaceParam(req, async () =>
          json(
            await boardIssues(workspaceParam(req), new URL(req.url).searchParams.has("refresh")),
          ),
        ),
      POST: async (req) => {
        try {
          const body = (await req.json()) as {
            summary: string;
            description?: string;
            workspace?: string;
          };
          return withWorkspace(workspaceById(body.workspace), async () =>
            json(await createIssue(body), 201),
          );
        } catch (e) {
          return fail(e);
        }
      },
    },

    // Directories left in the changes root by changes that are done: shown, never removed on
    // your behalf.
    "/api/leftovers": {
      GET: async () => json(await listLeftovers()),
    },
    "/api/leftovers/:name": {
      DELETE: async (req) => {
        try {
          await removeLeftover(req.params.name);
          return json(await listLeftovers());
        } catch (e) {
          return fail(e);
        }
      },
    },

    // Directory browser rooted at the configured repos root; paths that escape it are rejected.
    "/api/repos": {
      GET: async (req) => {
        try {
          // No path parameter at all: open where the configuration says. An explicit empty
          // one is the root, which is how "up" out of the starting directory works.
          return json(await browse(new URL(req.url).searchParams.get("path") ?? undefined));
        } catch (e) {
          return fail(e);
        }
      },
    },

    // Branches a new worktree can start from, for the base selector.
    "/api/repos/branches": {
      GET: async (req) => {
        try {
          const path = new URL(req.url).searchParams.get("path") ?? "";
          // Absolute paths come from the change itself; relative ones from the browser.
          return json(await remoteBranches(path.startsWith("/") ? path : absolutePath(path)));
        } catch (e) {
          return fail(e);
        }
      },
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
