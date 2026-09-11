import { Effect } from "effect";
import { runRoute } from "../../effect/run.ts";
import { workspaceById } from "../../workspace/server/index.ts";
import { capabilitiesLayer } from "./services.ts";
import { loaded, type CompiledRoute } from "./registry.ts";

/**
 * The extension route dispatcher: patterns compiled at install (registry.ts) and matched here,
 * against `/api/ext/<name>/<path>`. Unknown routes answer undefined, which the server turns
 * into its 404.
 */

// Compiled at install in the leaf registry, which owns the loaded shape; re-exported here so the
// dispatcher is where a reader looks for route matching.
export { compileRoutes, type CompiledRoute } from "./registry.ts";

/** Whether one compiled route fits a request, and what it captured: undefined is no fit, so
 * the caller tries the next pattern in order — the first fit wins. */
const matchRoute = (
  route: CompiledRoute,
  method: string,
  parts: readonly string[],
): Record<string, string> | undefined => {
  if (route.method !== method || route.segments.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const pattern = route.segments[i]!;
    const part = parts[i]!;
    if (pattern.startsWith(":")) {
      // The client always percent-encodes, and the core's routes decode, so a captured segment
      // is decoded here too — falling back to the raw segment when the escape is malformed.
      let value = part;
      try {
        value = decodeURIComponent(part);
      } catch {
        // A malformed escape was never a well-formed page or route: the raw segment stands.
      }
      params[pattern.slice(":".length)] = value;
    } else if (pattern !== part) return undefined;
  }
  return params;
};

/** The extension routes as one dispatcher for the server's route table: `/api/ext/<name>/<path>`,
 * run as the workspace the request names, failures mapped to status codes by the same
 * `runRoute` the core's routes go through. Patterns are tried in registration order within
 * the extension, then across extensions in load order — the first one whose shape fits wins,
 * and its captured parameters go to the handler. Unknown routes answer undefined, which the
 * server turns into its 404. */
export const dispatchExtensionRoute = (req: Request): Promise<Response> | undefined => {
  const url = new URL(req.url);
  const match = /^\/api\/ext\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return undefined;
  const ext = loaded.find((e) => e.name === match[1]);
  if (!ext) return undefined;
  const parts = match[2]!.split("/");
  for (const candidate of ext.routes) {
    const params = matchRoute(candidate, req.method, parts);
    if (!params) continue;
    const run = candidate.handler(req, params).pipe(
      Effect.provide(
        capabilitiesLayer(
          workspaceById(url.searchParams.get("workspace") ?? undefined),
          ext.name,
        ),
      ),
    );
    return runRoute(run);
  }
  return undefined;
};
