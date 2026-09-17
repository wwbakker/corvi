# One repositories directory, and a browser you can walk anywhere from

> **Kind:** decision · **Status:** accepted

## Context

The repository browser had two settings that overlapped: `reposRoot` was a boundary it refused to
walk above, and `reposStart` was the directory it opened on, falling back to whatever `reposRoot`
resolved to. A third, `Workspace.reposStart`, existed in the vocabulary, in the settings page and in
the validation — and was read by nothing: `/api/repos` never asked which context was open, so the
per-workspace value was a promise the page did not keep.

The boundary was not buying much. The server is already local, unauthenticated because the CLIs hold
the credentials, and behind a same-site check; a repository can live on another disk, under a home
directory that is a symlink, or beside a checkout rather than under one. And the page had no way to
pick a directory at all: every path in the settings was typed.

## Decision

**One setting, `repositoriesDirectory`, top level and per workspace.** It replaces `reposRoot` and
`reposStart`; a workspace's own value wins over the global one, and the global default is the user's
home directory. It is where browsing *starts*, not a fence: the browser can walk anywhere under `/`.
`reposRoot`, `reposStart` and `CORVI_REPOS_ROOT`/`CORVI_REPOS_START` are gone with no fallback read —
a clean break, like the identifiers rename, rather than a migration.

**The API speaks absolute paths, and `/` is the top.** An entry carries its absolute path, the
breadcrumb shows the current directory, `↑ Up` is `dirname`, and the root has no parent. This removes
the root-relative path the client used to reassemble — which would have produced `//Users/...` with
`/` as the root — and leaves the setting with exactly one meaning.

**Hidden directories are withheld by the server, not filtered by the page.** `browse` skips
dot-directories unless the request says `hidden=1`, which the listing pane's **show hidden
directories** checkbox sends. The request decides what a listing carries; the withholding also
happens before the per-entry `stat`, so a dot-directory costs nothing to skip. The box is view state
(per open, default off), not a setting: the config file stays a page of decisions.

**A symlinked directory is a directory.** The walk `stat`s each entry rather than trusting
`readdir`'s `dirent.isDirectory()`, so macOS' `/etc`, `/tmp` and `/var` — and a checkout reached
through a symlinked `~/Repos` — are browsable instead of appearing empty.

**The settings picker is the browser's own listing.** The pane is extracted
(`DirectoryListing`), and `DirectoryPicker` puts it in a dialog with "Use this directory"; a
`DirectoryField` pairs it with the ordinary text input. The same control is used for the changes
root, the archive root, the repositories directory (global and per workspace) and the extension
paths, so configuring a directory and choosing a repository look and feel the same. Typing a path,
including `~`, still works — the picker is an aid to the field, not the only way in.

## Consequences

- **An existing file that set `reposRoot` or `reposStart` is ignored**: the browser opens at `$HOME`
  until the new key is written. The retired keys are not destroyed — the config decode preserves
  unknown keys and the settings write merges — but nothing rewrites them either, so removing them is
  a hand-edit.
- **The per-workspace setting is wired, not decorative.** `/api/repos` resolves its start directory
  from `?workspace=`, so the wizard opens in the context the change is being made in and the
  repository dialog in the context the change belongs to.
- **The read surface is wider.** Any same-site request can list any directory under `/`. That is the
  trust level the rest of the API already has, and the same-site guard covers every request that
  reaches it, but it is worth stating in the manual rather than leaving implied.
- **A field may point at a directory that is gone.** Opening the picker then shows the browser's
  error rather than silently falling back, which is the honest answer for a setting the file can
  also be wrong about.
