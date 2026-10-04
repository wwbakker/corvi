/** Reading `tailscale`'s JSON: the pure half of the Tailscale capability.
 *
 * The output shapes are Tailscale's, not ours, so this is deliberately tolerant: a key that is
 * not there, a value of the wrong type, or output that is not JSON at all yields an empty/neutral
 * answer rather than an exception. The server module turns those answers into commands or a
 * status; a test drives them directly.
 */

/** The HTTPS port `tailscale serve` publishes on. The plan fixes it: the machine's tailnet URL
 * is the service root, `https://<machine>.<tailnet>.ts.net/`. */
export const SERVE_EXTERNAL_PORT = 443;

export type TailscaleSelf = {
  /** `BackendState === "Running"`. */
  readonly running: boolean;
  /** `Self.DNSName`, without the trailing dot. */
  readonly dnsName?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** `tailscale status --json`: the machine's own DNS name and whether the backend is up. */
export const parseTailscaleStatus = (stdout: string): TailscaleSelf => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { running: false };
  }
  const root = asRecord(parsed);
  const self = root === undefined ? undefined : asRecord(root["Self"]);
  const dns = self?.["DNSName"];
  return {
    running: root?.["BackendState"] === "Running",
    ...(typeof dns === "string" && dns.length > 0 ? { dnsName: dns.replace(/\.$/, "") } : {}),
  };
};

/** One `tailscale serve` handler: an external port with a handler on it. `targetPort` is the
 * loopback port when the handler proxies to one; absent for a redirect, text or other handler,
 * which still occupies the port and must not be displaced. */
export type ServeMapping = {
  readonly externalPort: number;
  /** The `<host>:<port>` key the serve status used, kept for a clear error message. */
  readonly host: string;
  readonly targetPort?: number;
};

/** The port an external `<host>:<port>` key names, from the right so the host's colons (IPv6) do
 * not confuse it. */
const externalPortOf = (key: string): number | undefined => {
  const separator = key.lastIndexOf(":");
  if (separator < 0) return undefined;
  const port = Number(key.slice(separator + 1));
  return Number.isInteger(port) && port > 0 ? port : undefined;
};

/** The loopback port a `Proxy` target names (`http://127.0.0.1:4110`). A target that is not a
 * URL with a port is not one of ours. */
const targetPortOf = (proxy: string): number | undefined => {
  try {
    const port = new URL(proxy).port;
    return port === "" ? undefined : Number(port);
  } catch {
    return undefined;
  }
};

/** `tailscale serve status --json`: every web handler, flattened to what the decision needs.
 * The documented shape is `Web["<host>:<port>"].Handlers["/"].Proxy`; a shape this does not
 * recognize contributes nothing. */
export const parseServeMappings = (stdout: string): ServeMapping[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const web = asRecord(asRecord(parsed)?.["Web"]);
  if (web === undefined) return [];
  const mappings: ServeMapping[] = [];
  for (const [host, entry] of Object.entries(web)) {
    const externalPort = externalPortOf(host);
    if (externalPort === undefined) continue;
    const handlers = asRecord(asRecord(entry)?.["Handlers"]);
    if (handlers === undefined) continue;
    for (const handler of Object.values(handlers)) {
      const proxy = asRecord(handler)?.["Proxy"];
      const targetPort = typeof proxy === "string" ? targetPortOf(proxy) : undefined;
      mappings.push(
        targetPort === undefined
          ? { externalPort, host }
          : { externalPort, host, targetPort },
      );
    }
  }
  return mappings;
};

/** The public URL a published external port serves at. */
export const publicUrlFor = (dnsName: string): string => `https://${dnsName}/`;

/** What enabling (or removing) would mean, given what 443 serves today. */
export type ServeDecision =
  | { readonly kind: "free" }
  | { readonly kind: "published" }
  /** 443 has our handler and at least one other: `tailscale serve --https=443 off` would clear
   * the whole tree, so Corvi refuses rather than displace the neighbour. */
  | { readonly kind: "mixed"; readonly foreignPorts: readonly (number | undefined)[] }
  | { readonly kind: "conflict"; readonly targetPort?: number };

/** Whether our external port is already published, 443 is free, or something else holds it. Only
 * a 443 tree that is entirely ours, or the absence of any 443 handler at all, lets an enable (or
 * a safe `off`) proceed. */
export const decideServe = (mappings: readonly ServeMapping[], port: number): ServeDecision => {
  const at443 = mappings.filter((mapping) => mapping.externalPort === SERVE_EXTERNAL_PORT);
  const foreign = at443.filter((mapping) => mapping.targetPort !== port);
  const ours = at443.filter((mapping) => mapping.targetPort === port);
  if (ours.length === 0 && foreign.length === 0) return { kind: "free" };
  if (ours.length === 0) return { kind: "conflict", targetPort: foreign[0]?.targetPort };
  if (foreign.length === 0) return { kind: "published" };
  return { kind: "mixed", foreignPorts: foreign.map((mapping) => mapping.targetPort) };
};

/** The first non-empty line of a command's stderr, for an error the UI can show. */
export const firstLine = (text: string): string =>
  text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
