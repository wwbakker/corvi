/**
 * The terminal host's wire protocol: the version, the shared shapes, and the pure parsing of a
 * client request. Keeping the request grammar here — separate from the socket I/O in `host.ts` —
 * is what makes it unit-testable and keeps `host.ts` about sessions, not JSON.
 *
 * Every request is one newline-delimited JSON object. `requestId` is optional and echoed on the
 * reply, so a client can match replies by id rather than by type order.
 */
export const PROTOCOL = 1;

/** A reporter's status as the host carries it: parsed from an OSC sequence and validated. */
export type SessionStatus = {
  readonly state: "working" | "waiting";
  readonly name?: string;
  readonly message?: string;
  readonly sessionName?: string;
  readonly at: string;
};

/** The host's ownership record, written beside the socket after it is listening. */
export type Owner = {
  readonly pid: number;
  readonly socket: string;
  readonly checkout: string;
  readonly buildId: string;
  readonly protocol: number;
  readonly startedAt: string;
  readonly node: string | undefined;
  readonly electron: string | undefined;
  readonly bun: string | undefined;
};

/** What `session.list` reports for one session, live or retained-dead. The opaque `metadata` is
 * whatever the server attached at open (at least a change id), so it can rebuild its registry
 * after a restart. */
export type SessionInfo = {
  readonly id: string;
  readonly incarnation: number;
  readonly cwd: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly alive: boolean;
  readonly lastSeq: number;
  readonly exitCode?: number;
  readonly signal?: number;
  readonly exitedAt?: string;
  readonly status?: SessionStatus;
  readonly metadata?: Record<string, string>;
};

type RequestBase = { readonly requestId?: number };

export type HostRequest =
  | ({ readonly type: "hello"; readonly token?: string } & RequestBase)
  | ({ readonly type: "host.info" } & RequestBase)
  | ({ readonly type: "host.shutdown" } & RequestBase)
  | ({
      readonly type: "session.open";
      readonly id: string;
      readonly cwd?: string;
      readonly command?: readonly string[];
      readonly cols?: number;
      readonly rows?: number;
      readonly env?: Record<string, string>;
      readonly metadata?: Record<string, string>;
    } & RequestBase)
  | ({ readonly type: "session.attach"; readonly id: string; readonly since?: number } & RequestBase)
  | ({ readonly type: "session.detach"; readonly id?: string } & RequestBase)
  | ({ readonly type: "session.write"; readonly id?: string; readonly data?: string } & RequestBase)
  | ({ readonly type: "session.resize"; readonly id?: string; readonly cols?: number; readonly rows?: number } & RequestBase)
  | ({ readonly type: "session.kill"; readonly id?: string } & RequestBase)
  | ({ readonly type: "session.list" } & RequestBase);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? [...(value as string[])] : undefined;

/** A string-to-string map for `env` and `metadata`: a non-string value drops the field. */
const asStringMap = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    map[key] = entry;
  }
  return map;
};

/** `requestId`, present only when the client sent a finite number. */
const requestIdOf = (value: Record<string, unknown>): RequestBase => {
  const requestId = asNumber(value.requestId);
  return requestId === undefined ? {} : { requestId };
};

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: V });

/** The `type` of a candidate request, for an error reply to an unparseable message. */
export const requestTypeOf = (value: unknown): string =>
  isRecord(value) && typeof value.type === "string" ? value.type : "unknown";

/** The `requestId` of a candidate request, so an error reply can still be correlated. */
export const requestIdFrom = (value: unknown): number | undefined =>
  isRecord(value) ? asNumber(value.requestId) : undefined;

/** Parse one raw client message. `undefined` means the shape is unknown or malformed; the host
 * answers an error rather than guessing. */
export const parseRequest = (value: unknown): HostRequest | undefined => {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const base = requestIdOf(value);
  switch (value.type) {
    case "hello":
      return { type: "hello", ...optional("token", asString(value.token)), ...base };
    case "host.info":
      return { type: "host.info", ...base };
    case "host.shutdown":
      return { type: "host.shutdown", ...base };
    case "session.open": {
      const id = asString(value.id);
      if (id === undefined) return undefined;
      return {
        type: "session.open",
        id,
        ...optional("cwd", asString(value.cwd)),
        ...optional("command", asStringArray(value.command)),
        ...optional("cols", asNumber(value.cols)),
        ...optional("rows", asNumber(value.rows)),
        ...optional("env", asStringMap(value.env)),
        ...optional("metadata", asStringMap(value.metadata)),
        ...base,
      };
    }
    case "session.attach": {
      const id = asString(value.id);
      if (id === undefined) return undefined;
      return { type: "session.attach", id, ...optional("since", asNumber(value.since)), ...base };
    }
    case "session.detach":
      return { type: "session.detach", ...optional("id", asString(value.id)), ...base };
    case "session.write":
      return {
        type: "session.write",
        ...optional("id", asString(value.id)),
        ...optional("data", asString(value.data)),
        ...base,
      };
    case "session.resize":
      return {
        type: "session.resize",
        ...optional("id", asString(value.id)),
        ...optional("cols", asNumber(value.cols)),
        ...optional("rows", asNumber(value.rows)),
        ...base,
      };
    case "session.kill":
      return { type: "session.kill", ...optional("id", asString(value.id)), ...base };
    case "session.list":
      return { type: "session.list", ...base };
    default:
      return undefined;
  }
};
