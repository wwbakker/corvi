/** The Harnesses page's read: every discovered harness, its chain, its resolved environment, its
 * warnings — and which harness the change's panes actually start.
 *
 * Each view is `previewHarness`'s answer, the same plan the launch writes, so the page cannot
 * disagree with what a pane will get.
 */
import { Effect, Result } from "effect";

import {
  resolveHarnessByKey,
  type HarnessWarning,
  type ResolvedHarness,
} from "@corvi/agents/harness-discovery";
import {
  harnessScopeRoot,
  HarnessGenerationError,
  type HarnessEnvironmentView,
} from "@corvi/agents/harness-generation";
import { previewHarness } from "@corvi/agents/node";
import type {
  HarnessListResponseDto,
  HarnessSummaryDto,
  HarnessViewDto,
  HarnessWarningDto,
} from "@corvi/contracts/harnesses";
import type { Change } from "@corvi/changes/record";
import { stateDir } from "@corvi/configuration/node";
import {
  harnessDiscoveryFor,
  harnessErrorText,
  harnessScopeRootsFor,
  harnessSelectionFor,
} from "./selection.ts";

const warningDto = (warning: HarnessWarning): HarnessWarningDto => ({
  kind: warning.kind,
  message: warning.message,
  ...(warning.kind === "unknown-name" ? { section: warning.section, name: warning.name } : {}),
  ...(warning.kind === "unresolved-path" ? { section: warning.section, entry: warning.entry } : {}),
  ...(warning.kind === "unsupported-field" ? { field: warning.field } : {}),
});

const viewDto = (view: HarnessEnvironmentView): HarnessViewDto => ({
  key: view.key,
  id: view.id,
  label: view.label,
  source: view.source,
  ...(view.sourceLabel === undefined ? {} : { sourceLabel: view.sourceLabel }),
  agent: view.agent,
  chain: view.chain.map((link) => ({
    key: link.key,
    id: link.id,
    label: link.label,
    source: link.source,
    ...(link.sourceLabel === undefined ? {} : { sourceLabel: link.sourceLabel }),
  })),
  generatedDir: view.generatedDir,
  ...(view.model === undefined ? {} : { model: view.model }),
  ...(view.effort === undefined ? {} : { effort: view.effort }),
  ...(view.enabledModels === undefined ? {} : { enabledModels: [...view.enabledModels] }),
  instructions: view.instructions,
  sections: {
    extensions: { mode: view.sections.extensions.mode, items: [...view.sections.extensions.items] },
    skills: { mode: view.sections.skills.mode, items: [...view.sections.skills.items] },
    packages: { mode: view.sections.packages.mode, items: [...view.sections.packages.items] },
    mcp: { mode: view.sections.mcp.mode, items: [...view.sections.mcp.items] },
  },
  warnings: view.warnings.map(warningDto),
});

const previewError = (error: HarnessGenerationError): string =>
  error.message.length > 0 ? error.message : `cannot generate the environment (${error.operation})`;

/** One harness's summary and view, or the reason it has none. */
const summaryOf = (
  change: Change,
  resolved: ResolvedHarness,
  scopeBase: string | undefined,
): Effect.Effect<HarnessSummaryDto> =>
  Effect.gen(function* () {
    const base: HarnessSummaryDto = {
      key: resolved.key,
      id: resolved.id,
      source: resolved.source,
      ...(resolved.sourceLabel === undefined ? {} : { sourceLabel: resolved.sourceLabel }),
      label: resolved.label,
      agent: resolved.agent,
      ...(resolved.fields.model === undefined ? {} : { model: resolved.fields.model }),
      ...(resolved.fields.effort === undefined ? {} : { effort: resolved.fields.effort }),
    };
    // opencode has no generated Pi environment yet: the summary still names it and its model.
    if (resolved.agent !== "pi") return base;
    const preview = yield* previewHarness({
      stateDir: stateDir(),
      changeId: change.id,
      harness: resolved,
      ...(scopeBase === undefined ? {} : { scopeBase }),
    }).pipe(Effect.result);
    return Result.isSuccess(preview)
      ? { ...base, view: viewDto(preview.success.view) }
      : { ...base, problem: previewError(preview.failure) };
  });

/** Every harness this change can use, with its resolved view and the change's selection. */
export const harnessListFor = (
  change: Change,
  options: { readonly views?: boolean } = {},
): Effect.Effect<HarnessListResponseDto> =>
  Effect.gen(function* () {
    const discovery = yield* harnessDiscoveryFor(change);
    const roots = yield* harnessScopeRootsFor(change);
    const harnesses: HarnessSummaryDto[] = [];
    for (const found of discovery.harnesses) {
      const resolved = resolveHarnessByKey(discovery, found.key);
      if (Result.isFailure(resolved)) {
        harnesses.push({
          key: found.key,
          id: found.id,
          source: found.source,
          ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
          label: found.harness.label,
          ...(found.harness.agent === undefined ? {} : { agent: found.harness.agent }),
          problem: harnessErrorText(resolved.failure),
        });
        continue;
      }
      const base: HarnessSummaryDto = {
        key: resolved.success.key,
        id: resolved.success.id,
        source: resolved.success.source,
        ...(resolved.success.sourceLabel === undefined ? {} : { sourceLabel: resolved.success.sourceLabel }),
        label: resolved.success.label,
        agent: resolved.success.agent,
        ...(resolved.success.fields.model === undefined ? {} : { model: resolved.success.fields.model }),
        ...(resolved.success.fields.effort === undefined ? {} : { effort: resolved.success.fields.effort }),
      };
      harnesses.push(
        options.views === false
          ? base
          : yield* summaryOf(change, resolved.success, harnessScopeRoot(resolved.success, roots)),
      );
    }
    return {
      harnesses,
      skipped: discovery.skipped.map((file) => ({ key: file.key, reasons: [...file.reasons] })),
      selection: harnessSelectionFor(change),
    };
  });
