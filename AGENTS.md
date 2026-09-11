# Working in this repository

## Ending test processes: use `bun run test:clean`

`bun test` starts real servers, ttyd terminals and whole tmux servers, and an aborted or timed-out
run can leave them behind. To end leftovers:

```sh
bun run test:clean            # what it would end, and what it leaves alone
bun run test:clean --kill     # end it
bun run test:clean --prune    # end it, and remove the leftover $TMPDIR/iwe-* paths
```

Never `pkill` or `kill` by port, by process name, or by "it looked like a leftover". Doing that
once destroyed the running `IWE.app`'s server, its ttyd, and a four-window tmux session — from the
outside they are indistinguishable from test strays by name, port and interface.

Ownership is decidable, because only tests carry these:

- test ttyds and test tmux servers serve change directories and sockets under `$TMPDIR/iwe-*`;
  the app's ttyds serve `~/changes/...` and your tmux listens on the default socket
  (`/private/tmp/tmux-<uid>/default` on macOS, `/tmp/tmux-<uid>/default` on Linux);
- test bun servers pass `--iwe-test-run` on the command line; `src/server.ts` ignores argv.

`bun run test` runs the kill pass when it exits (an `EXIT` trap), so strays do not accumulate
between runs.

A test that starts a server must spawn it as `["bun", "src/server.ts", "--iwe-test-run"]`; the
marker is what makes the server (and, on aborted runs, everything under it) findable.
`test/clean.test.ts` fails if one is missing.

If a pattern must be used anyway — `pkill -f` in code, say — anchor it to the executable and the
exact session. A tmux server's own command line is `tmux new-session -A -s <session> ...`, so an
unanchored pattern matching a session name kills the server and every window in it
(`src/terminal.ts` has the anchored form, and `test/terminal.test.ts` has the regression test).

## The app and this checkout

`~/Applications/Integrated Work Environment.app` runs `bun src/server.ts` from the checkout
recorded in its `Info.plist` (`IWERoot`), with `NODE_ENV=production`, on a fresh port per launch,
and stops it on quit. It does not watch files: source edits need a relaunch. `bun run app:install`
is only needed when `scripts/app/IWE.swift` itself changes.

## Documentation

Start at [`docs/README.md`](docs/README.md), which explains the split:

- `docs/guides/` — durable: the architecture, the extension contract, the server-code
  conventions, and the winning style. Read these before making a change.
- `docs/decisions/` — immutable: why a choice was made. Supersede, don't rewrite.
- `docs/plans/` — temporary: active work only. When a plan finishes, extract what is durable into
  `guides/` or `decisions/` and delete the plan.
