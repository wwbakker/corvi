import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import type { Workspace } from "./config.ts";

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
 */
const context = new AsyncLocalStorage<Workspace>();

/** Run everything inside this call as that workspace: every subprocess started, however deep,
 * gets its environment. */
export const withWorkspace = <T>(workspace: Workspace, work: () => T): T =>
  context.run(workspace, work);

export const currentWorkspace = (): Workspace | undefined => context.getStore();

const expand = (value: string): string =>
  value.startsWith("~") ? homedir() + value.slice(1) : value;

/**
 * What to add to a subprocess's environment here. `~` is expanded, since these are paths in
 * practice — `GH_CONFIG_DIR`, `AZURE_CONFIG_DIR`, `JIRA_CONFIG_FILE` — and a shell would have
 * done it.
 */
export function currentEnv(): Record<string, string> {
  const own = currentWorkspace()?.env ?? {};
  return Object.fromEntries(Object.entries(own).map(([key, value]) => [key, expand(value)]));
}
