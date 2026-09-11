# Review findings — plugin-system-3 migration slice (dd75843..8840245)

> **Kind:** review · **Status:** historical

Reviewer verdict up front: the slice is in good shape. `bunx tsc --noEmit`, `bun run lint` and
`bun run test` all pass at the known baseline (exactly one failure: `test/webkit.test.ts`,
environmental). All the promised strings survive verbatim (fact labels, the
`example-api - (pi working)` composition, the zsh quirk, loose-end sentences, the tooltip long
form, settings labels), the presenter merge / route matcher / summary merge / settings-bag
fallback chains behave as specified, no import cycles were introduced (`presenters.ts` as a
leaf is the right call), and the new seams all have tests with their intents intact. Findings
below, ordered by severity.

## Critical

None.

## Major

1. **User-visible ordering changed, contradicting the plan's preservation promise.**
   `docs/plans/extensions-migration-plan.md` ("Behaviour preservation") promises *"Every user-visible
   string, status code, ordering and fallback is preserved."* Two orderings changed:
   - **Loose ends**: the hardcoded list put the ticket first, then the pull requests; the
     contributor gatherer (`src/cancel.ts:126-137`) yields ci's PR lines before jira's ticket
     line (load order). The code comment admits it and `test/cancel.test.ts:202-205` documents
     it — but the plan was not updated to bless the change.
   - **Summary facts**: the card used to read pipelines, terminals, unresolved; now the core's
     terminals fact is always first (`src/summary.ts:36-44`), so a card with pipelines active
     reads "terminals idle" / "2 pipelines active" where it read "2 pipelines active" /
     "terminals idle" before.
   Why it matters: this is exactly the class of silent regression the preservation clause
   exists to catch, and the plan is the contract the next reader will trust. Fix: either keep
   the promise (sort facts/ends to the old order — e.g. let the host put the terminals fact
   second, or give contributors an explicit order) or amend the plan doc's preservation
   paragraph to name the two deliberate reorderings.

2. **Extension route params are not percent-decoded.** `src/extensions/index.ts:545-578`
   (`matchRoute` / `dispatchExtensionRoute`) captures the raw `url.pathname` segment, while:
   - Bun's own router decodes params (verified: `/svc/a%20b` → `"a b"`), which is what the old
     `/api/deployments/:service/versions` route relied on, and
   - the core's routes decode explicitly (`src/server.ts:155`, `decodeURIComponent(req.params.id)`),
   and the client always encodes (`encodeURIComponent(service)` in
   `src/extensions/deployments/DeployDialog.tsx`). A service whose pipeline name contains a
   space or other reserved character worked before and now arrives as `my%20service` to the
   `az` calls. Fix: `decodeURIComponent` each captured segment in `matchRoute` (guard with
   try/catch, falling back to the raw segment, like `viewOf` in `src/web/app.tsx` does).

3. **README still describes the retired `agentIn()`.** `README.md:746`: *"…which `agentIn()`
   reads out of the same `list-windows` call as everything else."* `agentIn` no longer exists —
   the `@agent` option is read by the `agents` extension's presenter (declared `paneOptions`),
   and the core never parses it. Fix: reword to point at the agents extension /
   `windowPresenters`, e.g. "which the agents extension's presenter reads out of the same
   `list-windows` call".

## Minor

4. **Duplicated comment block in `src/server.ts:273-276`.** The "What each change is called,
   refreshed from Jira…" comment appears twice (left behind when the deployments routes were
   excised). Delete one copy.

5. **`docs/guides/extensions.md:297` overclaims about list pruning.** It says *"clearing every row
   removes the key rather than writing an empty one"*, but `prune` (`src/settings.ts:184-193`)
   returns arrays untouched, so an emptied list is written to the file as `[]`. Downstream this
   is harmless (`bagList` in `src/deploySettings.ts` treats `[]` as unset), so either fix the
   sentence or make `prune` drop empty arrays.

6. **Settings page lost the effective-value placeholders, and one hint was reworded.** The old
   Jira/Azure sections showed the *effective* value as the placeholder (`In Progress`,
   `Done`, the current environments, `"accept"`); the generic renderer renders only the
   declared `placeholder`, which for `versionParameter`, `environmentParameter` and
   `environments` is nothing (`src/extensions/deployments/index.ts:47-62`), and the pipeline
   hint gained a prefix ("Two names in order: …"). Consider either accepting this and noting
   it, or letting `ExtensionSetting` declare `placeholderFromEffective`-style behaviour.

7. **Two tiny tooltip/placeholder regressions.**
   - `src/web/Sidebar.tsx:213`: the icon's `title` used to be the process name (or
     `pi working`); it is now the whole composed label. Defensible, but it is a user-visible
     string that changed without the plan naming it.
   - `src/web/ChangeCard.tsx:64-66`: while the summary loads, one `…` placeholder is shown
     where three used to be.
   Also, the wire shape in `docs/guides/extensions.md` ("`{ index, label, detail, icon?, state?,
   active, activity }`") omits `busy`, which the server does send (PresentedWindow carries it
   for the summary's use). One sentence in the doc would square it.

8. **`usePages` never refetches when enablement changes.** `src/web/workspaces.ts:92-107` keys
   the fetch on `workspaceId` only: toggling an extension on the settings page for the current
   context (whose save reloads workspaces but does not change the id) leaves the sidebar's
   page entries stale until a context switch or reload; and a failed `/api/pages` fetch is
   swallowed (`catch(() => {})`), silently dropping Deployments until the next fetch. Consider
   exposing a reload from `onSaved` and letting the error surface as "no answer yet".

## What was checked and found correct

- Strings: all fact labels, `example-api - (pi working)` / zsh quirk, loose-end sentences, the
  tooltip long form `name (command) in directory`, settings labels/hints, dialog strings —
  verbatim (`DeploymentsPage.tsx` and `DeployDialog.tsx` moved byte-identical apart from the
  route URLs).
- State semantics: `state` = worst offered verdict with the pipeline-in-flight-is-pending rule
  (in the ci contributor); window icon ok/idle; busy = not-a-shell with the agent believed
  over `node` (`waiting` not busy).
- Fallback chains: bag → legacy field → default → env for jira (`globalOf`) and deployments
  (`deploySettings`); `change.jira` legacy read via `ticketOf`; `jira: false` / `azure: false`
  migration (explicit `extensions` list untouched); `usesAzure` belt-and-braces guard.
- Error handling per `docs/guides/effect-conventions.md`: contributions typed `unknown` and swallowed
  by the host; deployments routes typed through `RouteError`/`BadRequestError`.
- Route matcher: `:param` captures exactly one segment, first-match-wins in registration
  order, unknown routes 404, method is part of the pattern (tested).
- Presenter merge: first per field, core defaults last, FORMAT asks only for declared options,
  `allWindowsEffect` still drops foreign sessions.
- No import cycles among types.ts / api.ts / extensions/index.ts / terminal.ts / summary.ts.
- Host registries normalize absent fields to `[]`; `LoadedExtension` agrees with `Extension`.
- Tests: new coverage for presenter precedence, route params, summary merge, loose ends,
  azure:false migration, settings round-trip, parity (pages included); no assertion weakened —
  the one loosened assertion (`terminal.test.ts` strip texts) is a legitimate race fix, and
  `cancel.test.ts` kept its assertion and documented the new order.
- Suite: `bunx tsc --noEmit` clean, `bun run lint` clean, `bun run test` = 132 pass / 1 fail
  (`test/webkit.test.ts`, the known environmental failure).

## Verdict

Ready to land after small fixes. Nothing critical; the three majors are a plan-doc
reconciliation (ordering), a one-line param decode in the route matcher, and a stale README
paragraph — all cheap, none structural. The minors are polish and can ride along or follow.
