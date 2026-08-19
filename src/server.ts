import { basename, join } from "node:path";
import index from "./web/index.html";
import {
  listChanges,
  readChange,
  writeChange,
  createChange,
  readNotes,
  writeNotes,
} from "./changes.ts";
import { integrations, provision, repoStatusOf, statusOne } from "./integrations/index.ts";
import { boardIssues, createIssue } from "./integrations/jira.ts";
import { browse } from "./repos.ts";
import { repoStates, setRepos } from "./integrations/git.ts";
import { completeChange, completionOf } from "./complete.ts";
import { prDescription } from "./description.ts";
import { CHANGE_STATES, type Change, type ChangeState } from "./types.ts";

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

const fail = (e: unknown): Response =>
  json({ error: e instanceof Error ? e.message : String(e) }, 400);

async function withChange(id: string, fn: (c: Change) => Promise<Response>): Promise<Response> {
  const change = await readChange(id);
  if (!change) return json({ error: `no such change: ${id}` }, 404);
  try {
    return await fn(change);
  } catch (e) {
    return fail(e);
  }
}

const server = Bun.serve({
  port: Number(process.env.IWE_PORT ?? 4000),
  // Localhost only: the server acts as you, using your CLI credentials, so it has no auth of its own.
  hostname: "127.0.0.1",
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/api/changes": {
      GET: async () => json(await listChanges()),
      // Creates the change, then provisions each component (worktrees, ticket status). The
      // change is written first, so a failing component leaves something to fix, not nothing.
      POST: async (req) => {
        try {
          const change = await createChange(
            (await req.json()) as Parameters<typeof createChange>[0],
          );
          return json({ change, provision: await provision(change) }, 201);
        } catch (e) {
          return fail(e);
        }
      },
    },

    // The components a dashboard shows. The browser asks each of them for its own widget, so
    // one slow CLI cannot hold up the rest of the page.
    "/api/integrations": {
      GET: () =>
        json(
          Object.values(integrations).map((i) => ({
            name: i.name,
            title: i.title,
            // Per-repository components are fetched a repository at a time by the browser.
            perRepo: Boolean(i.repoStatus),
            wide: Boolean(i.wide),
          })),
        ),
    },

    "/api/changes/:id": {
      // Just the change: instant, no CLI calls, so the header renders immediately.
      GET: async (req) => withChange(req.params.id, async (c) => json(c)),
      // Only the fields you can edit by hand: repositories have their own endpoint, and the
      // rest is either derived or the change's identity.
      PATCH: async (req) =>
        withChange(req.params.id, async (c) => {
          const patch = (await req.json()) as { state?: string };
          if (patch.state && !CHANGE_STATES.includes(patch.state as ChangeState)) {
            return json({ error: `unknown state: ${patch.state}` }, 400);
          }
          const updated: Change = { ...c, state: (patch.state as ChangeState) ?? c.state };
          await writeChange(updated);
          return json(updated);
        }),
    },

    // The repository list of a change, edited as a whole: the dialog sends the list it wants.
    "/api/changes/:id/repos": {
      GET: async (req) => withChange(req.params.id, async (c) => json(await repoStates(c))),
      POST: async (req) =>
        withChange(req.params.id, async (c) => {
          const body = (await req.json()) as { repos: string[]; force?: boolean };
          const result = await setRepos(c, body.repos, body.force);
          // 409: nothing was changed, the browser should ask about the unpushed work first.
          return "needsForce" in result ? json(result, 409) : json(result.change);
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

    // Text for a pull request, built here because the ticket summary comes from the Jira CLI.
    "/api/changes/:id/description": {
      GET: async (req) =>
        withChange(req.params.id, async (c) => json({ text: await prDescription(c) })),
    },

    // Completing a change: merge every outstanding pull request and close the ticket. GET
    // reports whether that is currently allowed, so the button can explain itself.
    "/api/changes/:id/complete": {
      GET: async (req) => withChange(req.params.id, async (c) => json(await completionOf(c))),
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
      GET: async (req) => json(await boardIssues(new URL(req.url).searchParams.has("refresh"))),
      POST: async (req) => {
        try {
          return json(
            await createIssue((await req.json()) as { summary: string; description?: string }),
            201,
          );
        } catch (e) {
          return fail(e);
        }
      },
    },

    // Directory browser rooted at the configured repos root; paths that escape it are rejected.
    "/api/repos": {
      GET: async (req) => {
        try {
          return json(await browse(new URL(req.url).searchParams.get("path") ?? ""));
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
  },
});

console.log(`iwe on ${server.url}`);
