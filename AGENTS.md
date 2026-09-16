# Working in this repository

## Ending test processes: use `bun run test:clean`

`bun test` starts real servers and whole tmux servers, and an aborted or timed-out
run can leave them behind. To end leftovers:

```sh
bun run test:clean            # what it would end, and what it leaves alone
bun run test:clean --kill     # end it
bun run test:clean --prune    # end it, and remove the leftover $TMPDIR/corvi-* paths
```

Never `pkill` or `kill` by port, by process name, or by "it looked like a leftover". Doing that
once destroyed the running `Corvi.app`'s server and a four-window tmux session — from the outside
they are indistinguishable from test strays by name and command line.

Ownership is decidable, because only tests carry these:

- test tmux servers listen on sockets under `$TMPDIR/corvi-*`, named explicitly: every tmux call in
  the tests passes `-S <socket>`, and the server under test gets the same path as
  `CORVI_TMUX_SOCKET` (src/terminals/server/tmux.ts). Corvi's own terminals live on the `corvi` socket
  (`-L corvi`: `tmux-<uid>/corvi` under `$TMUX_TMPDIR` or /tmp — `/private/tmp/tmux-<uid>/corvi` on
  macOS — or whatever `CORVI_TMUX_SOCKET` names; sessions made before that change are still on the
  default socket); the default socket (`/private/tmp/tmux-<uid>/default` on macOS,
  `/tmp/tmux-<uid>/default` on Linux) is yours — a bare `tmux` command from a test or a probe
  reaches nothing of Corvi's. Those directories are short on purpose: a unix socket path is capped
  at 103 characters, and macOS's `$TMPDIR` spends most of it before the run token is added — over
  the cap, tmux starts no server at all and the terminal tests fail with nothing to say why
  (test/helpers.ts, `tmuxTempDir`);
- test servers run on Node and pass `--corvi-test-run` on the command line; `src/server.ts`
  ignores argv. The app's server (`electron src/server.ts`) and a plain dev server carry no
  marker.

`bun run test` runs the kill pass when it exits (an `EXIT` trap), so strays do not accumulate
between runs.

A lone `bun test test/foo.test.ts` mints its own run token. A hand-set `CORVI_TEST_RUN` must be two
lowercase base36 words joined by a dot (`<base36>.<base36>`, what the suite's `date +%s.$$`
produces): that is the shape the cleaner reads back out of paths and command lines, and
`testRun()` refuses anything else before it can name a server the cleaner would have to leave
alone.

Do not name your own files or directories under `$TMPDIR` with an `corvi-` prefix — an `corvi-*`
entry no run names is a stray, and `test:clean --prune` removes it (a `/tmp/corvi-notes.log` reads
as a run named `notes.log`).

A test that starts a server must spawn it as `["node", "src/server.ts", "--corvi-test-run"]`; the
marker is what makes the server (and, on aborted runs, everything under it) findable.
`test/clean.test.ts` fails if one is missing.

Whatever the process, ownership is what decides: the marker for a server, the socket path for
tmux. Nothing else in this repository may end a process.

## The app and this checkout

`~/Applications/Corvi.app` (on Linux the `corvi` launcher) runs the
Electron window in `scripts/app/electron/`, which starts `src/server.ts` on Electron's own Node
(`ELECTRON_RUN_AS_NODE`) from the checkout recorded in the bundle's `package.json` (`corviRoot`),
with `NODE_ENV=production`, on a fresh port per launch, and stops it on quit. It does not watch
files: source edits need a relaunch.
`bun run app:install` is only needed when the host itself changes (`scripts/app/electron/`,
`scripts/app/mac.ts`, `scripts/app/linux.ts`) — server and page edits are picked up by the next
launch, because the server runs from this checkout.

## Documentation

Start at [`docs/README.md`](docs/README.md), which explains the split:

- `docs/guides/` — durable: the architecture, the extension contract, the server-code
  conventions, and the winning style. Read these before making a change.
- `docs/manual/` — the product manual: installing, configuration, changes, terminals,
  integrations. Keep it true for a user, not for an agent.
- `docs/decisions/` — immutable: why a choice was made. Supersede, don't rewrite.
- `docs/plans/` — temporary: active work only. When a plan finishes, extract what is durable into
  `guides/` or `decisions/` and delete the plan.
