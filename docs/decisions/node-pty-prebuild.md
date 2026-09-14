# node-pty is pinned to the 1.2.0 beta, for its prebuilt spawn-helper

> **Kind:** decision · **Status:** accepted

## Context

[`node-pty-terminal.md`](node-pty-terminal.md) chose node-pty and left macOS unverified — "the
darwin prebuild is the install path there, and the marker is noted here rather than claimed
tested", because that machine is Linux. Testing it there found the install path broken, for a
reason that is not IWE's code.

On macOS node-pty does not `forkpty` as it does elsewhere: it runs a tiny helper process,
`spawn-helper`, through `posix_spawn`. That helper is the stage a pty either starts through or
fails at.

- **node-pty 1.1.0 — npm's `latest` — publishes `prebuilds/darwin-{arm64,x64}/spawn-helper` with
  mode `644`: no execute bit** (microsoft/node-pty#850). `pty.fork` then throws
  `posix_spawnp failed.` before any shell exists, so every terminal in IWE answers `500` and the
  pane shows that message. Nothing downstream of it works: no tmux session, no window list.
  The upstream issue blames pnpm, but npm extracts the tarball the same way and Bun does too, so
  the defect is in what was published, not in who unpacked it.
- Linux was unaffected by accident: 1.1.0 ships no Linux prebuild at all, so `bun install`
  compiles the addon with `node-gyp`, and a compiler writes the helper executable.
- The fix — `chmod 755` before packing the prebuilds (PRs #858 and #866) — has shipped **only in
  the `1.2.0-beta.*` channel**. `latest` is still 1.1.0, and #919 requests a 1.1.x patch release
  that has not come.

## Decision

**`node-pty` is pinned to `1.2.0-beta.15`**, the newest published version and the first whose
darwin prebuild carries the execute bit. Pinned exactly, like `electron`, because a prerelease of
a native module should not float underfoot. When a stable release containing the fix exists, this
moves to `^1.2.0` and this document stops applying.

The alternatives, and why not:

- **`chmod` the installed helper from a `postinstall`.** The workaround other projects use, and it
  would work here. Rejected as the primary fix because it adds a lifecycle script to repair what
  the dependency is supposed to ship, and it changes nothing for Linux, where the pass would be a
  no-op. It remains the fallback if the pin ever has to be abandoned.
- **Build from source on macOS** (`npm_config_build_from_source`). Produces a correct helper, but
  makes a C toolchain and a compile part of every install on the platform where the shipped
  prebuild was the whole point.
- **`bun patch`.** Patches text; it cannot change a file mode.

## Consequences

- This supersedes two statements in [`node-pty-terminal.md`](node-pty-terminal.md): that "on Linux
  the install falls back to `node-gyp rebuild`, so a compiler is needed there", and that "macOS
  uses the shipped prebuild" as if that were a working install path. Both described 1.1.0.
- **The terminal works on macOS**, verified rather than noted: spawn, output, `resize` and exit
  under Node 24.13 and under Electron's own Node (v24.20) on darwin-arm64, and the whole of
  `test/terminal.test.ts` — a real browser against a real tmux session — green on this host.
- **Linux keeps working, verified rather than assumed**: the beta's `linux-arm64` prebuild loads
  and the same probe passes in a `node:24-slim` container. Two things follow. Linux now runs a
  prebuild instead of `node-gyp`, so the C toolchain and python3 the README demanded for it are no
  longer needed. And the Linux prebuilds ship no `spawn-helper` — correctly, since outside macOS
  `pty.cc` calls `forkpty` and never spawns a helper.
- Runtime behaviour is 1.1.0's. The betas differ in a newer `tsc`'s output, an optional
  `pixelSize` on `resize` (unused here), and `pty.process` no longer reporting `spawn_helper` as a
  process title.
- One thing to watch: the betas also drop `deps/` from the published files, so a platform without
  a prebuild — musl, say — may not be able to fall back to `node-gyp` on this version. Nothing
  needs that today.
- The cost of the pin is that `bun install` stays on the beta until someone moves it, and a beta
  of a native module is a beta. The exit condition is a stable release with the fix; #919 is where
  that stands.
