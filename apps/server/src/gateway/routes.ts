/** The gateway's route: `/remote/<source>/<rest>` proxies to that workspace's server, injecting
 * the workspace's device token. It sits behind the same origin guard as every route and, on the
 * external listener, the same device-token authorizer — it adds no auth of its own. */
import { runtimeGatewayTimeouts, runtimeRemoteAvailabilityObserve } from "../capabilities/runtime.ts";
import type { Server } from "../capabilities/serve.ts";
import { guard } from "../capabilities/web.ts";
import { bridgeUpgrade, proxyRequest, resolveRemote } from "./server/index.ts";

export const gatewayRoutes = guard({
  // A function handler rather than a method map: every method routes, and an upgrade is bridged.
  "/remote/:source/*": async (req, srv) => {
    const source = req.params.source;
    const resolved = resolveRemote(source);
    if (resolved.kind === "missing") {
      return new Response("no such remote workspace", { status: 404 });
    }
    if (resolved.kind === "invalid") {
      return new Response("the remote workspace's url is not http or https", { status: 502 });
    }
    const target = resolved.target;
    // The router captures the wildcard under `*`; the typed params only name the segment.
    const rest = (req.params as Record<string, string>)["*"] ?? "";
    const timeouts = runtimeGatewayTimeouts();
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const result = await bridgeUpgrade(req, srv as unknown as Server, target, rest, timeouts);
      // A failed handshake may ask for one coordinated health recheck; the health stream's own
      // verified state is still what classifies the workspace.
      if (result.observation !== undefined) runtimeRemoteAvailabilityObserve(source, result.observation);
      return result.response;
    }
    const result = await proxyRequest(req, target, rest, timeouts);
    // Only a transport-level failure is evidence about the remote itself; the remote answering
    // an operation with a validation error or a 5xx is not.
    if (result.transportFailure) runtimeRemoteAvailabilityObserve(source, "unreachable");
    else if (result.authentication) runtimeRemoteAvailabilityObserve(source, "authentication");
    return result.response;
  },
});
