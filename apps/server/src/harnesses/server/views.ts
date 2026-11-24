/** The Harness profiles page's read: every discovered profile, its chain, its resolved
 * environment, its warnings — and which profile the change's panes actually start.
 *
 * Each view is `previewEnvironment`'s answer, the same plan the launch writes, so the page cannot
 * disagree with what a pane will get.
 */
import { Effect, Result } from "effect";

import {
  resolveHarnessProfileByKey,
  type HarnessProfileWarning,
  type ResolvedHarnessProfile,
} from "@corvi/agents/harness-profile-discovery";
import {
  harnessProfileScopeRoot,
  EnvironmentGenerationError,
  type EnvironmentView,
} from "@corvi/agents/environment-generation";
import { previewEnvironment } from "@corvi/agents/node";
import type {
  HarnessProfileListResponseDto,
  HarnessProfileSummaryDto,
  HarnessProfileViewDto,
  HarnessProfileWarningDto,
} from "@corvi/contracts/harness-profiles";
import type { Change } from "@corvi/changes/record";
import { stateDir } from "@corvi/configuration/node";
import {
  harnessProfileDiscoveryFor,
  harnessProfileErrorText,
  harnessProfileScopeRootsFor,
  harnessProfileSelectionFor,
} from "./selection.ts";

const warningDto = (warning: HarnessProfileWarning): HarnessProfileWarningDto => ({
  kind: warning.kind,
  message: warning.message,
  ...(warning.kind === "unknown-name" ? { section: warning.section, name: warning.name } : {}),
  ...(warning.kind === "unresolved-path" ? { section: warning.section, entry: warning.entry } : {}),
  ...(warning.kind === "unsupported-field" ? { field: warning.field } : {}),
});

const viewDto = (view: EnvironmentView): HarnessProfileViewDto => ({
  key: view.key,
  id: view.id,
  label: view.label,
  source: view.source,
  ...(view.sourceLabel === undefined ? {} : { sourceLabel: view.sourceLabel }),
  harness: view.harness,
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

const previewError = (error: EnvironmentGenerationError): string =>
  error.message.length > 0 ? error.message : `cannot generate the environment (${error.operation})`;

/** The part of a summary that does not need a generated directory. */
const summaryBase = (resolved: ResolvedHarnessProfile): HarnessProfileSummaryDto => ({
  key: resolved.key,
  id: resolved.id,
  source: resolved.source,
  ...(resolved.sourceLabel === undefined ? {} : { sourceLabel: resolved.sourceLabel }),
  label: resolved.label,
  harness: resolved.harness,
  ...(resolved.fields.model === undefined ? {} : { model: resolved.fields.model }),
  ...(resolved.fields.effort === undefined ? {} : { effort: resolved.fields.effort }),
});

/** One harness profile's summary and view, or the reason it has none. */
const summaryOf = (
  change: Change,
  resolved: ResolvedHarnessProfile,
  scopeBase: string | undefined,
): Effect.Effect<HarnessProfileSummaryDto> =>
  Effect.gen(function* () {
    const base = summaryBase(resolved);
    // opencode has no generated Pi environment yet: the summary still names it and its model.
    if (resolved.harness !== "pi") return base;
    const preview = yield* previewEnvironment({
      stateDir: stateDir(),
      changeId: change.id,
      harnessProfile: resolved,
      ...(scopeBase === undefined ? {} : { scopeBase }),
    }).pipe(Effect.result);
    return Result.isSuccess(preview)
      ? { ...base, view: viewDto(preview.success.view) }
      : { ...base, problem: previewError(preview.failure) };
  });

/** Every harness profile this change can use, with its resolved view and the change's selection. */
export const harnessProfilesFor = (
  change: Change,
  options: { readonly views?: boolean } = {},
): Effect.Effect<HarnessProfileListResponseDto> =>
  Effect.gen(function* () {
    const discovery = yield* harnessProfileDiscoveryFor(change);
    const roots = yield* harnessProfileScopeRootsFor(change);
    const profiles: HarnessProfileSummaryDto[] = [];
    for (const found of discovery.profiles) {
      const resolved = resolveHarnessProfileByKey(discovery, found.key);
      if (Result.isFailure(resolved)) {
        profiles.push({
          key: found.key,
          id: found.id,
          source: found.source,
          ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
          label: found.harnessProfile.label,
          ...(found.harnessProfile.harness === undefined ? {} : { harness: found.harnessProfile.harness }),
          problem: harnessProfileErrorText(resolved.failure),
        });
        continue;
      }
      profiles.push(
        options.views === false
          ? summaryBase(resolved.success)
          : yield* summaryOf(change, resolved.success, harnessProfileScopeRoot(resolved.success, roots)),
      );
    }
    return {
      harnessProfiles: profiles,
      skipped: discovery.skipped.map((file) => ({ key: file.key, reasons: [...file.reasons] })),
      selection: harnessProfileSelectionFor(change),
    };
  });
