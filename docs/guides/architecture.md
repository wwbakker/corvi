# Architecture

Status: accepted target. The workspace layout below is not implemented yet. Follow the
[refactor plan](../plans/architecture-refactor.md); do not treat existing dependency exceptions
as rules for new code. The [decisions](../decisions/architecture.md) record scope and rationale.

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
  shell/                  subprocess execution capability
  workflows/              application operations and their required provider ports
  client/                 typed network operations for browser consumers
integrations/
  github/                 pull requests, issues, checks and stacks
  jira/                   Jira issues and transitions
  azure-devops/           pipelines, builds and deployments
  pi/                     Pi-specific status and session integration
  opencode/               OpenCode integration, when implemented
```

All entries under `apps/*`, `packages/*`, and `integrations/*` are ordinary Bun workspaces once
extracted. Integrations have no special loader or privilege level. Create packages when their
responsibility is implemented; do not scaffold empty future packages.

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
| `terminals` | Session/window identity, input, attachment and owned PTY resources | Agent conversation identity, change transitions or notifications policy |
| `agents` | Corvi-facing session identity, supported capabilities, prompts and status | A provider's SDK types or the assumption that every agent is a terminal |
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
shell -> contracts
workflows -> contracts, configuration, changes, repositories, terminals, agents
integrations/* -> contracts, shell, relevant capability APIs, workflows/ports
client -> contracts
apps/server -> workflows, capabilities, integrations, contracts
apps/web -> client, contracts, changes, terminals
apps/desktop -> web's public host contract, contracts
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

## Enforced package boundaries

Required as packages are extracted:

- Use `workspace:*` dependencies, a committed lockfile, and a shared catalog for common versions.
- Export explicit public entrypoints. Do not export `./*`, expose every implementation through a
  root barrel, or add an export just because a test wants an internal function.
- Cross-package imports use package names. Ban relative/absolute source-path imports and
  TypeScript aliases that bypass exports. Apply the graph to type-only and dynamic imports too.
- Record allowed edges and external allowlists in the root `architecture.json`; `bun run boundaries`
  checks resolved imports against it and reports cycles, undeclared dependencies, deep imports,
  relative escapes, and forbidden built-ins.
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

Browser code is similarly grouped under `apps/web/src/features/{changes,repositories,terminals,
agents,settings}`. Keep a feature's views, state, and request hooks together. Use deeper groups
such as `changes/creation` and `changes/lifecycle` when needed. Shared UI primitives live under
`shared/ui`; application navigation and composition live under `shell`.

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
- A terminal session is distinct from its PTY/browser attachment. Detaching must not kill a tmux
  session intended to survive the application.
- An agent conversation has its own provider/session identity; its terminal association is optional.

Reattaching a live terminal, recreating a stopped process, and resuming an agent conversation are
separate operations. Their initial product scope remains a [decision gate](../decisions/architecture.md).

## Integrations

Included integrations are statically composed. Per-workspace enablement and declarative action or
setting definitions remain useful, but do not require a universal contribution registry. Missing
optional integrations report their availability; they do not silently masquerade as empty data.

Third-party loading, public extension compatibility, dynamic client chunks, and hot replacement
are out of scope. Code hosted by another product, such as Corvi's Pi reporter, is an integration
adapter; removing Corvi's plugin host does not mean removing that adapter.
