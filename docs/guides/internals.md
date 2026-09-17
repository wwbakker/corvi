# Internals

> **Kind:** guide · **Status:** active

## Routing

`/` lists changes, `/new` is the wizard, `/azure-devops` is the Azure DevOps page, `/settings` is
the settings page, `/changes/<id>`
is a dashboard, and `/changes/<id>/review` and `/changes/<id>/terminals` are its other two pages. Navigation uses
`history.pushState`, the server serves the app for any non-`/api` path, so deep links, reload and
the browser's Back button all work.

## Pushing instead of polling

`GET /api/events` is one `EventSource` per tab. The server watches, and says when something
changed:

```
event: changes     the change files moved — created, renamed, finished, repositories edited
event: windows     tmux has different windows than it did
```

Polling would have every open page ask for the terminal windows every 1.5 seconds and the changes
every 30, against a browser limit of six connections per origin — the limit that forces the
dashboard's widgets to be unmounted rather than hidden while a terminal is on screen. Instead the
server looks once, on one timer, for everybody.

**Events carry no data.** They say that something changed; the page then asks for it through the
same cached routes as everything else. That keeps this small — no second way to fetch anything,
no state to keep in sync — and means a missed event costs one refresh rather than a screen that
disagrees with the disk.

Three things it has to get right:

- **The watcher stops when the last page goes.** A process quietly reading the disk and asking
  tmux twice a second for a browser that was closed this morning is a bug you never see. Clients
  are forgotten on the request's abort signal — the stream's own `cancel` is not called when a tab
  closes, so the signal is what removes them.
- **What was last seen survives a disconnect.** Without it the first look after every reconnect
  is silent, which swallows anything that changed while nobody was listening.
- **A quiet stream still has to say something.** Bun closes an idle connection after ten seconds,
  and an event stream is idle by definition. The browser reconnects, so it half-works: a drop and
  a reconnect six times a minute, for ever, with `request timed out` in the log each time. There
  is a heartbeat every five seconds, and `idleTimeout` is raised as well.

Routes that change something announce it themselves, so your own action lands at once rather than
within a tick. That is an optimisation, not the mechanism: the watcher would find it anyway, which
is why a `git` command in a terminal or a hand-edited `change.json` shows up too.

## Caching

Everything on a page costs a subprocess, and the same answers are wanted by the overview, the
dashboard and the summaries within seconds of each other. `src/capabilities/cache.ts` is one
stale-while-revalidate store for all of them:

```typescript
swr(`az:runs:${ref}`, 10_000, () => sh(["az", "pipelines", "runs", "list", ...]))
```

The first caller waits; everyone after that gets the stored answer at once. Past the ttl the
stored answer is still handed over immediately and a refresh runs behind it, so a page paints
from what was true a moment ago instead of waiting for what is true now. Callers asking at the
same moment share one run — six repositories asking Azure DevOps about the same branch is one
`az`.

Two rules keep that honest, and they are in the code rather than only here:

- **Decisions never read the cache.** `completionOf`, `mergeReadiness` and the merge itself call
  the CLIs live. A pull request that was approved ninety seconds ago is not a merge. The display
  path (`prItem`, `prSummary`) uses the cached lookup; `mergeReadiness` uses the raw one.
- **A failed refresh keeps the last good answer.** A Jira that is down means "no news", not "no
  data". With nothing to fall back on, the failure is the answer.

Actions forget what they just made wrong: `createPr` invalidates `gh:pr:<change>`, `moveIssue`
invalidates `jira:`.

What is cached, and for how long: pipeline definitions 5min, pipeline runs 10s, expected build
durations 5min, pull requests and their review threads 20s, pull request checks 15s, Jira issues
60s. Anything `git` answers is not cached — it costs about five milliseconds and changes while
you type.

The store is written to `~/.cache/corvi/state.json` every 30 seconds and on exit, and read at
startup (`CORVI_CACHE` overrides the path). Restarting is normal — a config change, a crash, an
edit `bun --watch` cannot take — and without it every page waits for the CLIs all over again.
Entries older than six hours are not restored: a page painted from yesterday's builds is worse
than a page that waits.

Subprocesses are bounded at eight at once (`CORVI_PARALLEL`), and a CLI that has not finished
within two minutes (`CORVI_CLI_TIMEOUT`) is killed and reported as a failed command. A dashboard of six repositories asks
about thirty things in parallel, and `az` is a few hundred milliseconds of CPU each; queueing
them costs nothing in wall time and keeps the machine usable while it happens.

## The cost of a refresh

The dashboard is CLI calls, and they are not all alike. `CORVI_TRACE=1` counts them and adds up
what each tool costs; measured on a six-repository change, one refresh is **60 processes and 6
seconds of CPU**. What keeps it cheap:

- **Worktrees are git's, all the way through.** `git worktree list --porcelain` plus
  `git status --porcelain=v2` costs ~25ms and answers everything the card shows, where a tool that
  gathered CI, diffs and summaries in parallel cost whole seconds of CPU per call. Creating and
  removing are `git worktree add` and `git worktree remove`, at a path Corvi computes — the layout
  is Corvi's own ([`../decisions/git-worktrees.md`](../decisions/git-worktrees.md)). The one
  expensive question — whether a branch's content is already in the default branch — is asked only
  where it decides something (a removal, or whether a removal has to ask), and its simulated merge
  is cached on the pair of tip SHAs the answer depends on, so a refresh never pays for it.
- **Azure DevOps calls are shared.** `az` is a Python program, a few hundred milliseconds of CPU
  per invocation, and every repository of a change asks about the same branch at the same moment.
  Pipeline definitions are held for five minutes, runs for ten seconds, and calls in flight are
  shared outright.
- **`origin/HEAD` is asked once per repository.**

The rest is network-bound rather than CPU-bound: `gh` is a Go binary that spends its time
waiting, and Jira is a `fetch` from this same process rather than a program at all.

## Dashboard loading

The page renders immediately: `GET /api/changes/:id` returns the change with no CLI calls, and
each component is fetched separately.

Every card cancels its requests when it goes away. Without that, the ten-odd slow per-repository
requests of a big change keep saturating the browser's six connections per origin (HTTP/1.1 on
localhost, so no multiplexing), and the next page waits seconds for a free one: measured at
2387ms for `GET /api/changes` mid-load versus 4ms idle.

Widget data is kept in a small in-memory cache in the browser (`src/app-root/cache.ts`), keyed by
change, component and repository, so leaving a change and coming back paints the last known rows
straight away while they refresh in the background. A page reload starts empty.

Components that work per repository (Local changes, CI) declare `repoStatus` instead of `status`,
and the browser fetches `GET /api/changes/:id/:card/repo?path=…` once per repository. The
rows appear one at a time as each repository answers, so a change with many repositories fills in
progressively instead of staying empty until the slowest CLI call returns. Everything refreshes
every 15s, and a slow or broken CLI delays only its own row.


## Tests and your real changes

`bun run test` sets `CORVI_ROOT` to a directory under `$TMPDIR`, so no test run can write into the
changes root you actually use. This is a safety net rather than the rule — test files set their
own root — because a test that does not would write into your real `~/corvi/changes`: `setRepos`
accepts an empty repository list and writes before it can notice, so `test/provision.test.ts`
would otherwise create a `PROJ-1` there.

## Testing the terminal

`test/terminal.test.ts` drives the real thing: it starts a server on a temporary root, opens the
Terminals tab in Chromium, types `pwd > out.txt` into the xterm.js pane and reads the file back,
then checks `ctrl-b c` reaches tmux, mouse mode is on, that tmux's own copy and the page's
chords reach the system clipboard, that a second page keeps the session, and that the shells
survive a server restart. It skips itself when `tmux` or Playwright's Chromium is missing rather
than failing.

## The page tests

`test/pages.test.ts` opens every route, round-trips the settings page and pins the notes card's
layout — in Chromium, because that is the engine the app renders in (the window is Electron,
docs/decisions/electron-host.md). `CORVI_ENGINE=webkit bun test test/pages.test.ts` runs the same
file in Playwright's WebKit where its bundle starts (natively on macOS; on Linux only where its
Ubuntu-built libraries match), which is the browser-side check for Safari; it skips rather than
fails when the chosen engine cannot launch.

The route sweep earned its place when the app was WebKit: it found the dashboard firing a
readiness check that answered `400` when there is no GitHub remote, which the page swallowed —
the menu item was disabled with nothing to say. That is now a reason like any other ("cannot
complete: …"). The podman harness that forced a WebKit run (`Containerfile.webkit`,
`bun run test:webkit`) is gone with the app's WebKitGTK dependency.

