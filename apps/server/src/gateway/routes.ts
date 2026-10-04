/** The gateway's route: `/remote/<source>/<rest>` proxies to that workspace's server, injecting
 * the workspace's device token. It sits behind the same origin guard as every route and, on the
 * external listener, the same device-token authorizer — it adds no auth of its own. */
import type { Server } from "../capabilities/serve.ts";
import { guard } from "../capabilities/web.ts";
import { bridgeUpgrade, proxyRequest, resolveRemote } from "./server/index.ts";

export const gatewayRoutes = guard({
  // A function handler rather than a method map: every method routes, and an upgrade is bridged.
  "/remote/:source/*": async (req, srv) => {
    const resolved = resolveRemote(req.params.source);
    if (resolved.kind === "missing") {
      return new Response("no such remote workspace", { status: 404 });
    }
    if (resolved.kind === "invalid") {
      return new Response("the remote workspace's url is not http or https", { status: 502 });
    }
    const target = resolved.target;
    // The router captures the wildcard under `*`; the typed params only name the segment.
    const rest = (req.params as Record<string, string>)["*"] ?? "";
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return bridgeUpgrade(req, srv as unknown as Server, target, rest);
    }
    return proxyRequest(req, target, rest);
  },
});
