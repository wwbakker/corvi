# Review fixes — plugin-system-3 (commit 6a21f73)

> **Kind:** review · **Status:** historical

Per finding:

1. **Major 1 (orderings)** — documented: the plan's "Behaviour preservation" paragraph now
   names the three accepted reorderings (terminals fact first, loose ends in extension load
   order with the sentence set unchanged, whole composed label as the tooltip). `docs/guides/extensions.md`
   mirrors one line each in the summary section and the cancelling section.
2. **Major 2 (route params)** — `matchRoute` in `src/extensions/index.ts` now
   `decodeURIComponent`s each captured `:param` segment, guarded with try/catch falling back to
   the raw segment (same pattern as `viewOf`). New test in `test/extensions.test.ts`:
   `/services/a%20b/versions` → `params.service === "a b"`, plus `web%2Fapi` and a malformed
   `%zz` escape staying raw.
3. **Major 3 (README)** — `README.md:746` now reads "which the agents extension's presenter
   reads out of the same `list-windows` call as everything else"; `agentIn()` is gone.
4. **Minor 4** — duplicated "What each change is called, refreshed from Jira…" comment block
   deleted from `src/server.ts`; one copy kept above `/api/titles`.
5. **Minor 5** — `docs/guides/extensions.md` global-settings paragraph now says an emptied list is
   written as `[]` and readers (like `bagList` in `src/deploySettings.ts`) treat that as unset.
6. **Minor 6** — one sentence added to the plan's preservation passage: extension-declared
   settings sections show the declared placeholder rather than the computed effective value.
7. **Minor 7** — the presented `TerminalWindow` shape in `docs/guides/extensions.md` gains `busy?`,
   with a note that it is sent for the summary's use, not rendered by the page. The tooltip and
   ellipsis changes are covered by the plan amendment (fix 1).
8. **Minor 8** — `usePages` in `src/web/workspaces.ts` exposes a `reload`, wired through
   `onSaved` in `src/web/app.tsx` alongside `reloadWorkspaces`; the context-change fetch keeps
   its `alive` guard and a failed fetch keeps the last good pages (comment states the recovery
   path). Hook shape follows the file's conventions (`useCallback` + object return like
   `useWorkspaces`).

Gate: `bunx tsc --noEmit` clean, `bun run lint` clean, `bun run test` 133 pass / 1 fail — the
one failure is `test/webkit.test.ts`, the known environmental baseline. Baseline was 132 pass;
the +1 is the new decode test.

Notes the review missed:
- The `README.md` paragraph the finding cited is adjacent to another mention of the retired
  reporter naming (`extensions/agent-state.ts`) — that one is still accurate (it describes the
  pi-side `busy-title` extension), left untouched.
- `usePages`'s failure-swallowing `catch` already kept the last good pages (the reviewer's
  "silently dropping Deployments" was only true on the very first fetch); the fix adds the
  reload path and makes the keep-last-good behaviour explicit in the comment.
- `docs/guides/extensions.md`'s route-matcher section ("Handlers receive `(req, params)`") was not
  amended to mention decoding, since the coordinator's instruction scoped the mirror to the
  summary and cancelling surfaces; the param contract is tested instead.
