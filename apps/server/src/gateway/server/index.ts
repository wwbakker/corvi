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
  type ProxyResult,
  type RemoteTarget,
  type UpgradeResult,
} from "./proxy.ts";
export { DEFAULT_GATEWAY_TIMEOUTS, type GatewayTimeouts } from "./timeouts.ts";
