# `wt` on Linux

**Verdict: no work needed.** The `wt` IWE depends on is
[Worktrunk](https://github.com/max-sixty/worktrunk) (crates.io: `worktrunk`, binary: `wt`) — a
Rust CLI for git worktree management. It is a first-class cross-platform tool with an official
Arch package. `sudo pacman -S worktrunk` is the whole story; every flag IWE passes exists and
behaves identically on Linux (verified by running the exact invocations from `src/` against a
real repo). The only Linux caveat is the name collision with Windows Terminal's `wt.exe`, which
does not exist on Linux — no conflict here.

## Install (Arch)

```bash
sudo pacman -S worktrunk
```

Alternatives, if the distro package is too old:

```bash
# Latest release, static musl binary (no runtime deps), from GitHub releases:
curl -LO https://github.com/max-sixty/worktrunk/releases/latest/download/worktrunk-x86_64-unknown-linux-musl.tar.xz
tar -xJf worktrunk-x86_64-unknown-linux-musl.tar.xz && install -m755 wt/wt ~/.local/bin/wt

# Or via cargo (any platform):
cargo install worktrunk
```

Not needed by IWE, but recommended for interactive use in a terminal — shell integration is what
lets `wt switch` change your shell's directory:

```bash
wt config shell install
```

## What IWE actually calls (verified against v0.76.0)

All invocations live in `src/integrations/git.ts` and `src/changes.ts`. Every one was executed
against a scratch repo on this Linux machine; results matched macOS behaviour exactly.

| IWE call | Purpose | Verified result on Linux |
|---|---|---|
| `wt --config <change>/wt.toml -C <repo> switch <branch> --no-cd` | attach to a change's worktree | ✓ switches without cd; `--no-cd` makes it server-safe |
| `wt --config <change>/wt.toml -C <repo> switch --create <branch> [base] --no-cd` | create branch + worktree | ✓ creates worktree at the configured path |
| `wt --config <change>/wt.toml -C <repo> remove --yes --foreground --force <branch>` | drop a change's worktree | ✓ removes synchronously; branch is **kept** when unmerged, **deleted** when it holds nothing — the exact semantics `src/cancel.ts` documents |
| `wt list --format=json` | (historical) worktree status | ✓ output matches the `WtEntry` shape in `git.ts`; IWE now reads status with plain `git status --porcelain=v2` instead, so this is unused |
| `worktree-path = "<change-dir>/{{ repo }}"` in per-change `wt.toml` | keeps worktrees inside the change directory | ✓ the `{{ repo }}` template variable is documented Worktrunk config (`worktrunk.dev/config`) and works |

## Parity notes

- **Nothing IWE uses is macOS-specific.** `-C`, `--config`, `--no-cd`, `--yes`, `--foreground`,
  `--force`, `list --format=json` and the `worktree-path` / `{{ repo }}` config key are all
  long-standing, cross-platform flags (present well before v0.68.0, the current Arch version).
- **Shell integration is not required.** `wt switch`'s directory-changing normally works through
  a shell hook; IWE always passes `--no-cd` and runs wt as a subprocess, so no
  `wt config shell install` is needed for the server — only for humans driving `wt` themselves.
- **Paths.** IWE's `wt.toml` writer (`src/changes.ts`) escapes backslashes for Windows; harmless
  on Linux. Worktrunk resolves `~` and XDG config paths (`~/.config/worktrunk/`) per XDG on
  Linux as expected. IWE always passes an absolute `--config` path, so nothing depends on the
  default location.
- **`--foreground` matters on a server.** By default `wt remove` detaches cleanup into a
  background process; IWE correctly passes `--foreground` so the dashboard reflects the removal
  immediately. Same-filesystem renames (worktrees live under the change dir) make this instant.
- **`wt list --format=json` schema.** Output now carries a schema-2 envelope; the shape IWE's
  `WtEntry` describes (schema-1 fields: `branch`, `path`, `working_tree`, `remote`,
  `main_state`, `is_main`) is still present per item. Irrelevant in practice since IWE parses
  git output, not wt output, for status.
- **Arch package lag.** `extra/worktrunk` is at 0.68.0 while upstream is 0.76.0; a fast-moving
  project, but nothing IWE relies on changed between those versions. If it ever matters, the
  musl binary or `cargo install` gives the latest.

## Version requirement

IWE needs at minimum a wt with `--config` and `switch --no-cd` — both present since well before
0.68.0, so **any current Arch package or upstream release works**. No pinning needed.

## If `wt` is missing entirely

IWE fails only where wt is invoked: creating (`switch --create`), attaching (`switch`), and
removing (`remove`) a change's worktree — plus a hard dependency when provisioning repos for a
change. Reading the dashboard (worktree status cards) still works, since that path uses plain
git. There is no fallback in IWE and none is planned; the README already lists `wt` as a
requirement, and the Linux support plan should keep that list identical on both platforms
(`sudo pacman -S worktrunk` on Arch, `brew install worktrunk` on macOS).
