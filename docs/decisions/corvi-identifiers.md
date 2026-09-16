# Corvi's identifiers

> **Kind:** decision · **Status:** accepted

## Context

The repository went public as Corvi in `8c08320` with the prose renamed and the identifiers
deliberately kept: the environment variables, the config and state directories, the tmux socket,
the installed bundle and the test harness all still said IWE. That commit called the rename "a
deliberate migration" and left it for later. This is it.

The names crossed every boundary at once. Environment variables (`IWE_*`), the config directory
(`~/.config/iwe`), the cache (`~/.cache/iwe`), runtime state (`~/.local/state/iwe`), the installed
app (`Integrated Work Environment.app`, `dev.iwe.app`, `~/.local/bin/iwe-app`), the tmux socket
(`-L iwe`, sessions `iwe-<id>`), the page-to-host bridge (`window.iweHost`), the test harness
(`IWE_TEST_RUN`, `--iwe-test-run`, `$TMPDIR/iwe-*`) and the change data root (`~/changes`).

## Decision

**One clean break, no compatibility reads.** Every identifier is Corvi's now. Old names are not
read, not aliased and not warned about; an install from before the rename moves once, with a
temporary script (`scripts/migrate-from-iwe.ts`, `bun run migrate:iwe`, dry-run by default). The
script moves the config, cache and state directories; the changes root with its archive; the
`wt.toml` worktree paths; repairs the git worktrees that moved with it; and renames the pi
sessions whose working directory was under the old root, header `cwd` included. A destination
that exists aborts rather than merges, and a custom `changesRoot` is refused rather than guessed
at. The script is deleted in a follow-up change once installs have moved.

**The name lives in one place.** `src/capabilities/identity.ts` holds the product name, the slug,
the `CORVI_` environment prefix and the XDG path defaults; every module derives its spelling from
it. A future rename or a sandbox copy has one file to touch.

**The change data moves to `~/corvi/changes`, and the archive is its own root.** Completed
changes go to `~/corvi/changes-archive` — a setting of its own (`archiveRoot`, env
`CORVI_ARCHIVE_ROOT`), not a child of the changes root, so listing the changes root never has to
filter the archive out and an archive can live on another disk. XDG paths stay XDG:
`~/.config/corvi`, `~/.cache/corvi`, `~/.local/state/corvi`, `~/.local/share/corvi/app`.

**The installed app is `Corvi.app` with the bundle id `nl.wwbakker.corvi`** (the owned domain,
rather than `dev.iwe.app`), the launcher is `~/.local/bin/corvi`, the desktop entry
`corvi.desktop`, and the tmux socket `-L corvi` with sessions `corvi-<id>`. `app:install` and
`app:uninstall` remove the old-named artifacts so nothing lingers in the Dock or the app grid.

Decision records and `docs/plans/archive/` keep the name they were written under; this record
supersedes the naming sentences in earlier decisions (notably `tmux-socket.md`) rather than
rewriting them.

## Consequences

- **External scripts and agent prompts that read `IWE_*` or the old config path break.** Nothing
  in the repository can fix that; the manual and this record name the replacements.
- **macOS asks for the microphone and notifications again**, because the bundle identifier it
  keys those grants by changed.
- **Terminals left on the old `-L iwe` socket are not adopted**: they stay reachable by hand
  until that tmux server dies, and new terminals start on `-L corvi`.
- **One directory move is unavoidable for `~/changes`.** Whatever is running inside a change —
  an agent, a terminal, a build — must be stopped first; the script says so, and repairs the
  worktrees afterwards.
- The migration script and its test are dead weight after the first installs move; removing them
  is a follow-up change, not a permanent fixture.
