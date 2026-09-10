# Style

> **Kind:** guide · **Status:** active

The codebase is mostly one style already: the error taxonomy, the SWR cache, the SSE design and
the extension contract all read the same way. Where it diverges, the divergence is migration
residue — two eras of code sitting side by side. This page names the winner on each axis, so a
new change does not have to pick.

Each rule states the tell: the thing that is on the wrong side of it.

## 1. Explicit over ambient

Anything a function needs arrives through its type — `Workspace`, `Shell`, `Cache`, `Settings`,
`Bus`. Do not read hidden global state to do the job.

- **Right:** `run(cmd): Effect<Result, CliError, Workspace | Shell>`.
- **Tell:** a module imports `sh`/`context.ts` and reaches for the workspace implicitly.
  That is `src/sh.ts`'s ambient path; the `Shell` capability is the same work with the
  dependency declared. Prefer `Shell`.

## 2. Effect is the API

Server modules expose Effect functions. A Promise wrapper is a second public surface, not a
convenience.

- **Right:** `readChange(id): Effect<Change | null, DecodeError>`.
- **Tell:** a Promise `readChange` next to the Effect one that only tests call. The browser boundary is HTTP, not a
  Promise facade.

## 3. A feature owns its code

Declaration, implementation and client half live together under `src/extensions/<name>/`.
`src/integrations/` holds only vendor clients genuinely shared by more than one feature
(`git.ts` qualifies); top-level `src/*.ts` is core domain that is not a feature.

- **Right:** `extensions/jira/{index.ts,jira.ts,jiraHttp.ts,client.tsx}`.
- **Tell:** a feature whose implementation is a top-level module plus an `integrations/` file plus
  an `extensions/` folder (deployments, until item 5 of the refactor plan). See
  [`architecture.md`](architecture.md#where-a-features-code-lives).

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
- **Tell:** `src/local.ts` both meaning "local changes" alongside `integrations/git.ts`; or a
  new field named `integration` where the wire contract (`Widget.integration`) does not force it.

## 6. Shared means shared

A helper used twice lives in one place — preferably on the service it belongs to
(`shSoft`/`cliJson` are `Shell` behaviour), not cloned.

- **Right:** one `shSoft`, one `cliJson`, one `messageOf`.
- **Tell:** eight copies of `shSoft`, each with its own "Result-branching contract" comment.

## 7. State has an owner

The registry, the config object, the cache: each lives in one named module that others import.

- **Right:** a leaf `registry.ts` exports `loaded`; `terminal.ts` imports it.
- **Tell:** a `setPresenterSource` side-channel installed by the host to avoid an import cycle.

## 8. Hooks fetch, components render

Client data goes through the shared hooks and cache (`web/state.ts`, `web/cache.ts`); components
do not call `fetch` themselves.

- **Right:** `useChanges`, `useWindows`, `useTerminal`.
- **Tell:** a component building its own URL and calling `api(...)` outside a hook.

## 9. Shared code has a place, not a list

Pure code both the server and the browser need lives in `src/shared/`. The lint boundary is then
structural rather than an allowlist.

- **Right:** `src/shared/branch.ts`, importable from `src/web/**`.
- **Tell:** `eslint.config.js` listing `!../types.ts`, `!../branch.ts`,
  `!../deployConventions.ts`.

## Checklist for a change

- Does anything new read ambient state? If yes, pass it through the type instead.
- Did you add a Promise wrapper? If yes, why — tests can use the Effect.
- Did you put implementation somewhere other than its feature folder? If yes, say why in the
  decision record.
- Did you throw, or return a shape the caller must probe? Fail with the taxonomy.
- Did you copy a helper? Put it where both callers already import from.
- Is there a second name for a thing that already has one? Use the existing name.
