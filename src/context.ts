import { Effect, Option } from "effect";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import type { Workspace } from "./config.ts";
import { workspaceOption } from "./effect/tags.ts";

/**
 * Which workspace the work in hand belongs to, for the length of one request.
 *
 * Every CLI IWE runs authenticates as somebody: `gh` as a GitHub account, `az` as a tenant,
 * `jira` against a site. With one client that is whatever you logged in as; with two it is a
 * question with two answers, and the answer belongs to the request rather than to the machine.
 *
 * The workspace itself lives in the `Workspace` tag (src/effect/tags.ts), provided per request
 * by the server — and by the extension host, which provides the tag alongside its capability
 * services. One seam still needs the ambient store: the Promise-shaped test facades (and the
 * core code paths tests reach without a request scope) read it as a fallback. Extension code
 * no longer does: its effects receive the workspace through the R channel.
 */
const context = new AsyncLocalStorage<Workspace>();

// TODO-MIGRATE — compatibility shim only: the server provides the Workspace tag; the ambient
// store survives solely so the Promise-shaped test facades (and code paths tests reach without
// a request scope) carry a workspace. It is set by `provideWorkspace` and read nowhere but
// `currentWorkspaceEffect`'s fallback.

/** Carry the request's workspace across the Promise seam: run this Promise (and every Effect it
 * starts, however deep) as that workspace. */
export const provideWorkspace = <A>(workspace: Workspace, work: () => Promise<A>): Promise<A> =>
  context.run(workspace, work);

/** Run everything inside this call as that workspace: every subprocess started, however deep,
 * gets its environment. Kept for the test suite, which scopes ambient reads with it directly. */
export const withWorkspace = <A>(workspace: Workspace, work: () => A): A =>
  context.run(workspace, work);

const expand = (value: string): string =>
  value.startsWith("~") ? homedir() + value.slice(1) : value;

/** The workspace for the work in hand, as an Effect read: the `Workspace` tag when a route
 * provided it, the ambient store when a Promise-seam call bridged it, and `undefined` outside a
 * request — no lookup may fail where the old ambient context returned undefined. */
export const currentWorkspaceEffect: Effect.Effect<Workspace | undefined> = Effect.map(
  workspaceOption,
  (option) => (Option.isSome(option) ? option.value : context.getStore()),
);

/** What to add to a subprocess's environment here. `~` is expanded, since these are paths in
 * practice — `GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_CONFIG_FILE` — and a shell would have
 * done it. Empty outside a request, which is every call IWE made before workspaces existed.
 * Kept for the test suite, which must pass unmodified; Effect code reads currentEnvEffect.
 * Exported for the Shell capability's live layer, which reads the workspace from its tag. */
export function currentEnv(): Record<string, string> {
  return envOf(context.getStore());
}

export const envOf = (workspace: Workspace | undefined): Record<string, string> => {
  const own = workspace?.env ?? {};
  return Object.fromEntries(Object.entries(own).map(([key, value]) => [key, expand(value)]));
};

/** What to add to a subprocess's environment, as an Effect read (see `currentEnv`). */
export const currentEnvEffect: Effect.Effect<Record<string, string>> = Effect.map(
  currentWorkspaceEffect,
  envOf,
);
