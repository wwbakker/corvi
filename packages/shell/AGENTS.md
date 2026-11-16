# @corvi/shell

## Owns

The shell capability: the interface re-exported from the contract and the Node implementation.

- `.`: re-exports `Shell` (the tag), `ShellShape` and `Result` from
  `@corvi/contracts/capabilities`; `run` requires `Workspace`
  (`@corvi/contracts/workspace`) because the environment comes from the request's workspace.
- `./node`: `makeNodeShell(options)` — the real implementation: one spawned process per call, a
  shared concurrency gate, a timeout that kills the child, optional per-tool tracing, and the
  host's environment policy passed in. `NodeShellShape` takes the environment explicitly.
- `./cli`: the helpers every caller of a CLI shares: `cliJson` (tolerant `--json` decoding),
  `soft`/`shSoft` (a failure as a `ShellResult`), `messageOf`, and `withShell` with `sh`,
  `shOrThrow` and `shSoft` — the one reader of the optional `Shell` and `Workspace` services. A
  package with no process fallback gets a 127 `CliError`; the application passes its node shell
  as the fallback.

## Does not own

Which environment a child gets, how long a CLI may run, how many may run at once, or what the
product's variables are called. The host constructs the node shell with those policies
(`apps/server/src/capabilities/shell.ts`) and provides the `Shell` layer; `Workspace` and the failure
vocabulary live in `@corvi/contracts`.

## Public entrypoints

- `@corvi/shell`: `Shell`, `ShellShape`, `Result`
- `@corvi/shell/node`: `makeNodeShell`, `NodeShellOptions`, `NodeShellShape`, `TraceEntry`
- `@corvi/shell/cli`: `cliJson`, `soft`, `messageOf`, `withShell`, `sh`, `shOrThrow`, `shSoft`

## Dependencies

`@corvi/contracts` (the `Workspace` tag and `CliError`) and `effect`. Node built-ins live under
`src/node/`, the owner's adapter entrypoint.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
