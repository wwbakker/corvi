# Architecture

Status: accepted and implemented. The layout below is the workspace as checked;
`bun run boundaries` enforces the declared graph. The [decisions](../decisions/architecture.md)
record scope and rationale.

## Structure

Corvi is a modular application around a change, its repositories, terminals, and agents.
Capabilities own coherent domains. Workflows compose capabilities into application behavior.
Integrations implement external-system behavior. Applications assemble, expose, and present it.

```text
apps/
  server/                 HTTP/SSE/WebSocket hosting and backend composition
  web/                    React application and browser platform adapter
  desktop/                Electron host and native platform adapter
packages/
  contracts/              shared boundary schemas and values
  configuration/          configuration and workspace resolution
  changes/                change records, lifecycle rules, documents and storage
  repositories/           Git repositories, branches, worktrees and local review
  terminals/              terminal sessions, windows and attachment
  agents/                 Corvi-facing agent-session capabilities
  actions/                named actions from files, delivered to terminal sessions
  shell/                  subprocess execution capability
  workflows/              application operations and their required provider ports
  client/                 typed network operations for browser consumers
integrations/
  github/                 pull requests, issues, checks and stacks
  jira/                   Jira issues and transitions
  azure-devops/           pipelines, builds and deployments
  pi/                     pi's agent-state reporter (runs inside pi)
  opencode/               opencode's agent-state reporter (runs inside opencode)
```

All entries under `apps/*`, `packages/*`, and `integrations/*` are ordinary Bun workspaces once
extracted. Integrations have no special loader or privilege level. Create packages when their
responsibility is implemented; do not scaffold empty future packages. The agent reporters
(`integrations/pi`, `integrations/opencode`) are ordinary workspace packages too, even though they
run inside their agent rather than in Corvi's server: `bun run extension:install:pi` and
`bun run extension:install:opencode` symlink their source into the agent's plugin directory, in
the shape that agent's loader resolves.
Their only dependency is type-only on their agent's SDK, and they speak the reporter protocol
stated in docs/manual/terminals.md.

Git, worktrees, and changes are fundamental. GitHub is not. Keep Git semantics explicit rather
than inventing a generic version-control framework. Do not create a universal provider API for
unrelated issue, build, and agent operations.

## Ownership

| Owner | Owns | Does not own |
| --- | --- | --- |
| `contracts` | Shared IDs, decoded values, request/response/event schemas and transport declarations | Services, I/O, global state, native imports, every package's internal types |
| `configuration` | Validated configuration snapshots, workspace selection, precedence and updates | Integration execution or a mutable singleton configuration object |
| `changes` | Change invariants, persistence, archive location, plan/notes documents and associated metadata | Git commands, terminals, provider calls, HTTP or dashboard cards |
| `repositories` | Repository facts, branches, worktree operations, safety assessment, diffs and commits | Corvi change-directory policy, persisted changes, GitHub calls or widgets |
| `terminals` | The vocabulary shared by server and page: the new-window key, the CSI u sequences a terminal cannot encode, the command option names, and the pure window presenters | Agent conversation identity, change transitions or notifications policy |
| `agents` | Corvi-facing session identity, supported capabilities, prompts and status | A provider's SDK types or the assumption that every agent is a terminal |
| `actions` | Action files and their vocabulary, scope precedence, placeholder rendering, delivery to terminal sessions | Terminal/session mechanics, change lifecycle, HTTP handlers or JSX |
| `workflows` | Create/start/complete/cancel, multi-repository operations, overview aggregation and action orchestration | Vendor CLI/HTTP encoding, storage primitives, JSX or HTTP responses |
| `integrations/*` | External authentication, transport, decoding and provider-specific operations | Change lifecycle policy, HTTP handlers for Corvi, or rendering cards |
| `client` | Named network operations, decoding, cancellation and transport failures | Backend implementation imports or application startup |
| Applications | Concrete wiring, hosting, native capabilities and presentation | Duplicated domain rules |

Configuration receives integration setting definitions through composition; it does not import
all integrations. Persisted provider metadata has a named owner and codec. Removing the plugin
host must not remove notes, tickets, settings, or other included functionality.

## Dependency graph

`A -> B` means A imports B. These are allowed categories, not a requirement to depend on every
listed package. Manifests declare only actual dependencies.

```text
contracts -> Effect schema/data utilities only
configuration -> contracts
changes -> contracts
repositories -> contracts
terminals -> contracts
agents -> contracts
actions -> contracts, terminals
shell -> contracts
workflows -> contracts, configuration, changes, repositories, terminals, agents
integrations/* -> contracts, configuration, shell, relevant capability APIs, workflows/ports
client -> contracts
apps/server -> workflows, capabilities, integrations, contracts, client
apps/web -> client, contracts, changes, terminals
apps/desktop -> web's public host contract, contracts, configuration
```

`shell` is the subprocess capability: any layer that runs a CLI may depend on it (repositories,
terminals, agents, workflows, `integrations/*`, `apps/server`). The provider's environment,
limits and tracing stay with the host that constructs the Node implementation.

The browser application is built ahead of time: `bun run build:web` bundles `apps/web/src` into
`apps/web/dist`, and `apps/server` serves that directory (`CORVI_WEB_DIST` names another one).
The server does not import the web application, and the desktop host imports `@corvi/web`'s
public host contract (`./host`, `./chrome`) rather than reaching into its sources.

Packages may use appropriate external libraries; OS implementations belong behind their owner's
adapter entrypoint. Applications may import Node built-ins directly — `apps/server` hosts the
process and the native capabilities, and `apps/desktop` is the Electron host — while `apps/web`
is browser-only and extracted packages keep OS implementations behind their owner's `node`
adapter entrypoint (`src/node/`). The checked graph records an application's right to Node as
`"node": true` on its rule (`architecture.json`). Backend capabilities can require existing
Effect platform services. Do not
create a catch-all `core`, `common`, or `utils` workspace to bypass ownership.

**Provider inversion:** when a workflow needs a provider-independent operation such as inspecting
or merging a pull request, define the narrow port under `workflows/ports`. An integration implements
that port; the server supplies its Layer. A port entrypoint must not load workflow implementations.
Workflows never import a concrete integration. Agent-provider ports belong to `agents`, not to a
second agent model in workflows.

An integration may depend on another integration's public capability when it genuinely builds on
that behavior. Record the specific edge in the checked graph and obtain approval; never introduce
a reverse edge or a blanket integration-to-integration exemption. Extract a shared capability only
when it represents a real concept, not merely to make a cycle disappear.

Desktop starts the server as a process boundary, not by importing the server application. Its
platform adapter implements the web app's host contract. Frontend features do not import integration
backend packages, including their types; shared public values belong in contracts.

## Remote access and remote workspaces

A server binds loopback only. **Remote access** is a second loopback listener that `tailscale
serve` publishes on the tailnet; the two listeners differ only in trust. The local listener is
tokenless — being on the loopback port is the authorization. The external listener requires a
paired device token on every `/api/*` request and WebSocket upgrade, as an `Authorization: Bearer`
header (the gateway and CLI) or an `HttpOnly`, `Secure`, `SameSite=Strict` cookie (the remote
page), with the two pairing routes (`/api/devices/pairing-codes/redeem` and `/api/devices/pair`)
reachable without one. Trust is a property of
the listener, not of the peer address: through `tailscale serve` every connection arrives from
`127.0.0.1`. The capabilities live in `apps/server`: `src/devices` (identity, pairing, token
hashing, the request authorizer), `src/remote-access` (the listener's lifecycle), `src/tailscale`
(publishing it as a `serve` mapping and reporting the URL), `src/gateway` and `src/remote-events`.
The last two are the page's way to a remote server, described next.

The local server is also the **single origin** for its page and its gateway to remote servers. A
workspace is **local** (a settings scope) or **remote** (a `remote` target on another server,
with a device token). The page keeps relative URLs; for a remote workspace they go to
`/remote/<source>/…`, which the gateway strips and forwards with the token, streaming SSE and
bridging the terminal WebSocket. The fan-in holds one subscription per remote workspace and
re-emits what it hears on the local bus under the `source` event, preserving the page's
single-`EventSource` design. The page only ever talks to a remote through the gateway; the token
never reaches it.

### Remote availability

The per-workspace event subscription is also the **availability owner** (`src/remote-events`). An
open stream that keeps sending bytes — event frames or the server's heartbeat comments — means
the workspace is reachable; silence past a bound means it is not. The bounded checks
(`src/remote-events/model.ts`, constructed by the entrypoint and injectable in tests) are a time
to the response headers, a time to the stream's first byte, and a maximum silence between bytes —
never a total-duration timeout on a healthy stream. The owner publishes one snapshot per change
(`@corvi/contracts/availability`): `checking`, `available`, or `unavailable` with a fixed reason
(`unreachable`, `authentication`, `configuration`, `stalled`). A random per-target `generation`
changes whenever `url`, `workspace` or `token` changes (never derived from the credential), and a
per-target `revision` plus a random per-process `instance` order snapshots. A consumer establishes
the instance from an authoritative read (a fresh page, or the snapshot it fetches after
reconnecting) and applies events only for that instance and a newer revision; an event naming an
unestablished instance is an old server's frame and triggers a snapshot re-read rather than being
accepted as a new epoch.

`GET /api/remotes/availability` serves the whole map; `POST /api/remotes/:source/availability/retry`
asks for one coordinated check (a healthy stream is left untouched, and repeated asks share one
attempt); the `availability` event carries the same map on the page's existing stream. The gateway
reports only transport- and auth-level observations to the owner, and those at most request a
recheck — a single failed operation never classifies a workspace, and an operation error from the
remote is not whole-source offline. Retries are health reconnects: a failed write is never queued
or replayed. The gateway's own waits are the same kind: a read (GET/HEAD) has a response-header
bound — except the subagent `await`/`next` long polls, which are parked by design and answer only
when they have something — a WebSocket handshake has a deadline, and a mutation or command has no
total-duration bound at all (`src/gateway/server/timeouts.ts`). The bounds come from the
entrypoint: an invalid or non-positive environment value falls back to the named default.

Because two servers can mint the same change id, the browser identifies a change by
`(source, changeId)`: change lists are merged and tagged with their source, and change-scoped
reads, writes and terminal sockets route to the owning source. The network type is unchanged — a
remote client is `makeCorviClient({ baseUrl: "/remote/<id>" })`. Contracts carry the shared
shapes: the device record and pairing schemas, the Tailscale publication status, the `source`
event envelope, and the config's `remoteAccess`, `devices` and `RemoteWorkspace`. `@corvi/client`
adds the `workspaces.pairRemote` operation the settings editor calls — the local server performs
the outbound redeem through the same client and returns the token for the draft — and the server's
`src/workspace` keeps the remote entry with the same per-item tolerance, masking its device token
and every declared extension secret at both read surfaces.

## Enforced package boundaries

Required as packages are extracted:

- Use `workspace:*` dependencies, a committed lockfile, and a shared catalog for common versions.
- Export explicit public entrypoints. Do not export `./*`, expose every implementation through a
  root barrel, or add an export just because a test wants an internal function.
- Cross-package imports use package names. Ban relative/absolute source-path imports and
  TypeScript aliases that bypass exports. Apply the graph to type-only and dynamic imports too.
- Record allowed edges and external allowlists in the root `architecture.json`; `bun run boundaries`
  checks resolved imports against it and reports cycles, rules without packages, undeclared
  dependencies, deep imports, relative escapes, and forbidden built-ins.
- Check resolved dependencies for forbidden edges and cycles. Package manifests alone are not
  enforcement; hoisting can hide undeclared dependencies.
- Bundle browser entrypoints in tests and reject Node, PTY, backend and unintended integration
  runtime inputs. Smoke-test package resolution under Node and Electron's Node.
- Keep public interface/model entrypoints separate from adapters that load native modules.

The checked graph (`architecture.json`, `scripts/architecture.ts`) enforces these rules for
extracted workspaces, with negative fixtures proving it rejects violations. Do not disable a
failing rule without replacing its protection; migrate enforcement with the package it protects.

## Layout within a package

Group by concept rather than file kind or one file per operation:

```text
repositories/src/
  worktrees/
    service.ts
    model.ts
    errors.ts
    internal/
      git-worktrees.ts
      parse-worktrees.ts
  branches/
  status/
  node/
    layer.ts
```

A cohesive module may contain several related operations. Split when a distinct concept or
boundary becomes clearer, not to reach a file-count or line-count target. Tests may inspect
package-local implementation details without publishing them.

Browser code lives in `apps/web/src`, grouped by feature: `change-page`, `dashboard`,
`settings`, `terminals`, `wizard` and `workspace` each keep that feature's views, state and
request hooks together, with its browser half under `client/` (at the directory root for
`wizard`). Where a feature has vocabulary of its own, a `model.ts` beside the half re-exports
the contract it lives in, as `settings/model.ts` and `workspace/model.ts` do. The server half
sits in the like-named directory under `apps/server/src` where the feature has one — `settings/server`, `terminals/server`,
`dashboard/server`, `workspace/server` — and `change-page` and the wizard are answered by the
change capability (`apps/server/src/change/server`) instead. Add a deeper group once a
feature's browser half grows a second distinct concept, the way a package does above.
`app-root` is the page's composition root and holds the pieces every feature draws from —
navigation, icons, action menus. `domain` holds the pure vocabulary shared between features:
no I/O, no Effect, no ambient process. `integrations` holds the included integrations'
browser halves, `client.tsx` composing each `<name>/client.tsx`; `node` is the script that
bundles the tree ahead of time, not browser code. `bun run lint` enforces the half boundary:
a browser half may import a server module only with `import type`, which erases before the
bundle sees it.

## Composition and execution

The server builds Layers, selects integrations for configured workspaces, supplies their ports,
and starts listeners and background work inside an application scope. Importing a package does
none of this. Use ordinary Effect Layers; no custom service-graph compiler is required.

**Complete a change:** a workflow reads the change, evaluates repository and provider readiness,
records progress, performs ordered provider steps, removes safe worktrees, stops the owned terminal,
and archives the change. Repositories receive concrete repository/worktree inputs, not the whole
Change. The workflow gets paths from the change owner. HTTP only decodes, invokes, and encodes;
the UI renders results and asks for confirmation.

**Run an action:** a button or status-transition workflow invokes the same typed application
operation. Distinguish a process command, terminal input, agent prompt, and provider skill; do not
collapse them to `execute(string)`. Storage never triggers these operations implicitly. Retry,
failure, and duplicate handling require an explicit policy before status automation is implemented.

## Sessions and lifetimes

- An application owns configuration services, caches, integration instances, and background tasks.
- Workspace-specific credentials and configuration are explicit values or scoped service instances,
  never whichever workspace a browser most recently selected.
- A request or attachment owns its cancellation and acquired resources.
- A terminal session is distinct from its PTY/browser attachment. Detaching must not kill a host
  session intended to survive the application.
- An agent conversation has its own provider/session identity; its terminal association is optional.

Reattaching a live terminal, recreating a stopped process, and resuming an agent conversation are
separate operations. Their initial product scope remains a [decision gate](../decisions/architecture.md).

## Integrations

Included integrations are statically composed. Per-workspace enablement and declarative action or
setting definitions remain useful, but do not require a universal contribution registry. Missing
optional integrations report their availability; they do not silently masquerade as empty data.

Third-party loading, public extension compatibility, dynamic client chunks, and hot replacement
are out of scope. Code hosted by another product, such as Corvi's agent reporters
(`integrations/pi`, `integrations/opencode`), is an integration
adapter; removing Corvi's plugin host does not mean removing that adapter.
