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
 * This is deliberately ambient rather than a parameter. The alternative is threading an
 * environment through forty call sites that have no other reason to know about it — `git status`
 * does not care whose workspace it is in, it just has to run as the right one.
 *
 * The workspace itself now lives in the `Workspace` tag (src/effect/tags.ts). Until the server
 * wiring task lands, both worlds coexist: Promise-era callers keep the AsyncLocalStorage below,
 * Effect code reads the tag with `Effect.serviceOption` and falls back to the ambient store, so
 * a request scoped by either mechanism sees exactly the old behavior — `undefined` workspace and
 * an empty environment override outside a request.
 */
const context = new AsyncLocalStorage<Workspace>();

/** Run everything inside this call as that workspace: every subprocess started, however deep,
 * gets its environment. */
// TODO-MIGRATE — Promise-era entry point; the server wiring task replaces this with
// Effect.provideService(Workspace, ...), and the AsyncLocalStorage goes with it.
export const withWorkspace = <T>(workspace: Workspace, work: () => T): T =>
  context.run(workspace, work);

// TODO-MIGRATE — Promise-era read; Effect code uses currentWorkspaceEffect below.
export const currentWorkspace = (): Workspace | undefined => context.getStore();

const expand = (value: string): string =>
  value.startsWith("~") ? homedir() + value.slice(1) : value;

/** What to add to a subprocess's environment here. `~` is expanded, since these are paths in
 * practice — `GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_CONFIG_FILE` — and a shell would have
 * done it. */
// TODO-MIGRATE — Promise-era read; Effect code uses currentEnvEffect below.
export function currentEnv(): Record<string, string> {
  return envOf(context.getStore());
}

const envOf = (workspace: Workspace | undefined): Record<string, string> => {
  const own = workspace?.env ?? {};
  return Object.fromEntries(Object.entries(own).map(([key, value]) => [key, expand(value)]));
};

/** The workspace for the work in hand, as an Effect read: the `Workspace` tag when a route
 * provided it, the ambient AsyncLocalStorage when Promise-era code scoped the request, and
 * `undefined` outside a request — no lookup may fail where the old ambient context returned
 * undefined. */
export const currentWorkspaceEffect: Effect.Effect<Workspace | undefined> = Effect.map(
  workspaceOption,
  (option) => (Option.isSome(option) ? option.value : context.getStore()),
);

/** What to add to a subprocess's environment, as an Effect read (see `currentEnv`). */
export const currentEnvEffect: Effect.Effect<Record<string, string>> = Effect.map(
  currentWorkspaceEffect,
  envOf,
);
