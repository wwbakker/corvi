# Style

> **Kind:** guide · **Status:** active

The codebase is mostly one style already: the error taxonomy, the SWR cache, the SSE design and
the extension contract all read the same way. Where it diverges, one side is the winner and the
other is a mistake waiting to be copied. This page names the winner on each axis, so a new
change does not have to pick.

Each rule states the tell: the thing that is on the wrong side of it.

## 1. Explicit over ambient

Anything a function needs arrives through its type — `Workspace`, `Shell`, `Cache`, `Settings`,
`Bus`. Do not read hidden global state to do the job.

- **Right:** `run(cmd): Effect<Result, CliError, Workspace | Shell>`.
- **Tell:** a module imports `sh` and reaches for the workspace implicitly. The `Shell`
  capability is the same work with the dependency declared; prefer it.

## 2. Effect is the API

Server modules expose Effect functions. A Promise wrapper is a second public surface, not a
convenience.

- **Right:** `readChange(id): Effect<Change | null, DecodeError>`.
- **Tell:** a Promise `readChange` next to the Effect one that only tests call. The browser
  boundary is HTTP, never a Promise wrapper.

## 3. A feature is one module directory

A feature — a domain of the product, or an extension — is one directory whose aspects travel
together:

- `server/` — the implementation that shells out or touches the filesystem; its `index.ts` is
  the module's public face.
- `client/` — the browser half, when there is one.
- `model.ts` — the pure, synchronous logic both halves share.

Any aspect may be absent: a headless module has no `client/`, a vocabulary-only one no
`server/`. `src/vendors/` holds only vendor clients genuinely shared by more than one
feature (`git.ts` qualifies); the rest of the substrate is `src/domain/` (the vocabulary),
`src/capabilities/` and `src/extension-host/`, with each feature's HTTP table in its own
`routes.ts`.

**One role per file.** `store.ts` is the persisted state, `create.ts` one operation,
`presenter.ts` the merge, `summary.ts` the composition — not a second concern grafted onto an
existing file.

**Submodules are modules.** `wizard/` and `dashboard/` are directories with their
own aspects and their own face, and the same rules nest as far as a feature needs. The
composition lives in the submodule that composes, which is why `dashboard` can depend on
`terminal` and the host without `change/server` closing a cycle.

**The server half's `index.ts` is the module's face, and nothing inside the module imports
it.** Code outside enters through the barrel; siblings import each other directly, which is
what keeps the barrel cycle-free. A submodule whose face is a browser component re-exports it
from a top-level `index.ts` (`wizard/index.ts`); client components are otherwise imported
file-to-file, because a barrel of components would pull every one into the page bundle. A leaf
that a second module needs by value — `extension-host/registry.ts`, `change/server/store.ts`,
`terminals/server/proxy.ts`, `settings/server/legacySettings.ts` — is the exception rule 7 names.

- **Right:** `extensions/jira/{index.ts,jira.ts,jiraHttp.ts,client.tsx}`;
  `change/server/index.ts` is the change face every route imports;
  `bun run outline src/change/server` prints it.
- **Tell:** a feature whose implementation is a top-level module plus an `integrations/` file plus
  an `extensions/` folder, or a route importing `change/server/complete.ts` directly instead of
  the barrel. See [`architecture.md`](architecture.md#where-a-features-code-lives).

## 4. Failure is a value

Failures are typed values in the `E` channel, or data (`exit codes are data`). Never a `throw`
across a module boundary; never a duck the caller probes.

- **Right:** `Effect.fail(new ConflictError({ message, needsForce }))`.
- **Tell:** `throw new BadRequestError(...)` in sync code caught by an `attempt()` at the route
  boundary (`applyPatch`); or `result.needsForce` probed with `"needsForce" in result`.

## 5. One name per concept

"Extension" is the noun. "Integration" survives only where the wire contract forces it. A module
is named for the one thing it does.

- **Right:** `extensions/`, `extensionsFor`, one `git.ts`.
- **Tell:** `src/extensions/review/` (the change's local-changes tab) and
  `src/vendors/git.ts` (the worktree engine) both reading as "the local changes code";
  or a
  new field named `integration` where the wire contract (`Widget.integration`) does not force it.

## 6. Shared means shared

A helper used twice lives in one place — preferably on the service it belongs to
(`shSoft`/`cliJson` are `Shell` behaviour), not cloned.

- **Right:** one `shSoft`, one `cliJson`, one `messageOf`.
- **Tell:** the same helper defined in several modules, each carrying its own copy of the same
  explanatory comment. `shSoft`, `cliJson`, `messageOf` and `fs` live in
  `src/capabilities/effect/support.ts`.

## 7. State has an owner

The registry, the config object, the cache: each lives in one named module that others import.

- **Right:** a leaf `registry.ts` exports `loaded`; `terminals/server/presenter.ts` imports it.
- **Tell:** a side-channel installed by the host to avoid an import cycle, rather than a leaf
  module both sides import.

Four leaves are imported across module boundaries rather than through a barrel, and why is not
one reason:

- `extension-host/registry.ts` and `change/server/store.ts` break cycles by depending on **state**
  rather than on a half: the registry sits below both the host and the terminal, and the store is
  the change module's state leaf.
- `terminals/server/proxy.ts` is the terminal's **HTTP boundary**: the files that speak HTTP (the
  terminal routes, the app-root routes, `server.ts`, `capabilities/web.ts`) import it directly so the module's
  barrel does not drag the ttyd page script into every consumer of `stopTerminal` or
  `listWindows`.
- `settings/server/legacySettings.ts` shares one **precedence chain** — the settings bag, then the
  flat field, then the environment — with the workspace config loader and the top-level
  deployments settings; it is stated once there rather than copied or routed through the barrel.

## 8. Hooks fetch, components render

Client data goes through the shared hooks and cache (`app-root/state.ts`, `app-root/cache.ts`); components
do not call `fetch` themselves.

- **Right:** `useChanges`, `useWindows`, `useTerminal`.
- **Tell:** a component building its own URL and calling `api(...)` outside a hook.

## 9. Shared code has a place, not a list

Pure code both the server and the browser need lives in `src/domain/`. The lint boundary is
then structural rather than an allowlist: it covers every server tree, for `src/app-root/**` and for
a module's `client/` half (and the wizard's module-root browser half), with only `src/domain/`, a
module's `model.ts` importable by value.

- **Right:** `src/domain/change.ts`, importable from `src/app-root/**` and `src/change-page/client/**`.
- **Tell:** `eslint.config.js` naming the individual files it lets through instead of pointing at
  `src/domain/`.

## 10. Read the interface before the implementation

A module's exports are its surface, and the compiler already checks that surface against the
callers. `bun run outline <file|directory>` prints the exported names, full types and doc
summaries with every body elided, so a change is planned against the contract rather than
discovered by reading the implementation. An Effect signature carries its error and requirement
channels (`Effect<A, E, R>`), which is what makes the outline normally enough.

- **Right:** `bun run outline src/change/server` before adding a route that calls it.
- **Tell:** opening `store.ts` to find out what `change/server/index.ts` promises, or a module
  whose only readable description is its implementation.

## Checklist for a change

- Does anything new read ambient state? If yes, pass it through the type instead.
- Did you add a Promise wrapper? If yes, why — tests can use the Effect.
- Did you put implementation somewhere other than its feature folder? If yes, say why in the
  decision record.
- Did you throw, or return a shape the caller must probe? Fail with the taxonomy.
- Did you copy a helper? Put it where both callers already import from.
- Is there a second name for a thing that already has one? Use the existing name.
