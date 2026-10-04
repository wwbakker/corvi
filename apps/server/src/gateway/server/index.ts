/** The gateway module's public face: the route table and the proxy pieces a test drives. */
export {
  bridgeUpgrade,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  gatewaySockets,
  isGatewaySocket,
  proxyRequest,
  resolveRemote,
  upstreamUrl,
  type GatewayBridge,
  type GatewaySocket,
  type RemoteTarget,
} from "./proxy.ts";
