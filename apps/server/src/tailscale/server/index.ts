/** The Tailscale capability's public face: the operations the routes call, and the pure parsing
 * and decisions a test drives directly. */
export { publishTailscale, reconcileTailscale, tailscaleStatus, unpublishTailscale } from "./tailscale.ts";
export { persistPublishedPort, publicationPath, readPublishedPort } from "./publication.ts";
export {
  decideServe,
  firstLine,
  parseServeMappings,
  parseTailscaleStatus,
  publicUrlFor,
  SERVE_EXTERNAL_PORT,
  type ServeDecision,
  type ServeMapping,
  type TailscaleSelf,
} from "./parse.ts";
