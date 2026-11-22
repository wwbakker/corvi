/** Generating a pane's Pi environment and opening a harness window.
 *
 * Every launch regenerates the agent directory from the current files, logs its warnings once,
 * and hands the pane `PI_CODING_AGENT_DIR`. A pane that starts Pi automatically also gets the
 * warnings as its first line, printed before Pi draws anything.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";

import {
  describeHarnessError,
  resolveHarness,
  resolveHarnessByKey,
  type HarnessWarning,
  type ResolvedHarness,
} from "@corvi/agents/harness-discovery";
import { generatedHarnessDir, harnessScopeRoot, resolveOverlayPaths } from "@corvi/agents/harness-generation";
import { discoverProfiles, generateHarness } from "@corvi/agents/node";
import { harnessFieldsOfProfile } from "@corvi/agents/profile";
import type { SubagentRecord } from "@corvi/agents/instance";
import type { OpenHarnessWindowDto } from "@corvi/contracts/harnesses";
import { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import { stateDir } from "@corvi/configuration/node";
import { changeDir } from "../../change/server/index.ts";
import { fileRootsFor } from "../../capabilities/fileRoots.ts";
import { currentPaneDirectory, newWindowRunningAsync } from "../../terminals/server/windows.ts";
import {
  harnessDefaultsFor,
  harnessDiscoveryFor,
  harnessScopeBaseFor,
  harnessScopeRootsFor,
  resolveSelection,
  resolveSubagentHarness,
  selectedHarnessKey,
} from "./selection.ts";

/** One pane's generated environment. A non-Pi harness has no generated directory and an empty
 * environment: opencode keeps today's behavior. */
export type HarnessLaunch = {
  readonly dir?: string;
  readonly env: Record<string, string>;
  /** The discovery key, what a window records so two same-labelled harnesses stay distinct. */
  readonly key: string;
  readonly label: string;
  /** The one line to print before Pi starts, when there is a warning. */
  readonly warningsLine?: string;
};

const badHarness = (message: string): BadRequestError => new BadRequestError({ message });

/** One line for the pane: every warning, joined, with the harness it belongs to. */
export const warningsLineOf = (label: string, warnings: readonly HarnessWarning[]): string | undefined =>
  warnings.length === 0
    ? undefined
    : `harness "${label}": ${warnings.map((warning) => warning.message).join("; ")}`;

/** The Corvi log: one line per launch that had warnings, so a pane's broken environment is
 * findable after the fact. */
const logWarnings = (label: string, warnings: readonly HarnessWarning[]): Effect.Effect<void> =>
  Effect.sync(() => {
    const line = warningsLineOf(label, warnings);
    if (line !== undefined) console.error(line);
  });

const generated = (
  change: Change,
  resolved: ResolvedHarness,
  options: { readonly dir?: string },
): Effect.Effect<HarnessLaunch, BadRequestError> =>
  Effect.gen(function* () {
    // opencode has no generated Pi environment: only its model applies, and its launch keeps the
    // old behavior. Warnings still reach the log and the pane.
    if (resolved.agent !== "pi") {
      yield* logWarnings(resolved.label, resolved.warnings);
      const noEnvironment: Record<string, string> = {};
      return {
        env: noEnvironment,
        key: resolved.key,
        label: resolved.label,
        ...(warningsLineOf(resolved.label, resolved.warnings) === undefined
          ? {}
          : { warningsLine: warningsLineOf(resolved.label, resolved.warnings) }),
      };
    }
    const scopeBase = yield* harnessScopeBaseFor(change, resolved);
    const generatedHarness = yield* generateHarness({
      stateDir: stateDir(),
      changeId: change.id,
      harness: resolved,
      ...(scopeBase === undefined ? {} : { scopeBase }),
      ...(options.dir === undefined ? {} : { dir: options.dir }),
    }).pipe(Effect.mapError((error) => badHarness(error.message)));
    const warningsLine = warningsLineOf(generatedHarness.view.label, generatedHarness.view.warnings);
    yield* logWarnings(generatedHarness.view.label, generatedHarness.view.warnings);
    return {
      dir: generatedHarness.dir,
      env: { PI_CODING_AGENT_DIR: generatedHarness.dir },
      key: generatedHarness.view.key,
      label: generatedHarness.view.label,
      ...(warningsLine === undefined ? {} : { warningsLine }),
    };
  });

/** The environment a shell or command pane of this change starts with: its user harness. */
export const userHarnessLaunch = (change: Change): Effect.Effect<HarnessLaunch, BadRequestError> =>
  Effect.gen(function* () {
    const discovery = yield* harnessDiscoveryFor(change);
    const resolved = resolveSelection(change, discovery, "user");
    if (Result.isFailure(resolved)) {
      return yield* badHarness(
        `harness "${selectedHarnessKey(change, "user")}": ${describeHarnessError(resolved.failure)}`,
      );
    }
    return yield* generated(change, resolved.success, {});
  });

/** The environment for a named harness key, as the new-terminal dialog selects one. */
export const harnessLaunchByKey = (
  change: Change,
  key: string,
): Effect.Effect<HarnessLaunch, BadRequestError> =>
  Effect.gen(function* () {
    const discovery = yield* harnessDiscoveryFor(change);
    const resolved = resolveHarnessByKey(discovery, key);
    if (Result.isFailure(resolved)) {
      return yield* badHarness(`harness "${key}": ${describeHarnessError(resolved.failure)}`);
    }
    return yield* generated(change, resolved.success, {});
  });

/** A subagent's environment: its pinned harness (the profile's id on older records), with the
 * profile's current harness fields overlaid. A pinned key that disappeared is a clear refusal. */
export const subagentHarnessLaunch = (
  change: Change,
  record: Pick<SubagentRecord, "id" | "profile" | "harness" | "harnessKey">,
): Effect.Effect<HarnessLaunch, BadRequestError> =>
  Effect.gen(function* () {
    const profiles = yield* Effect.flatMap(fileRootsFor(change, "subagents"), discoverProfiles);
    const found = profiles.profiles.find((entry) => entry.key === record.profile);
    const profile = found?.profile;
    const profileBase =
      found === undefined ? undefined : harnessScopeRoot(found, yield* harnessScopeRootsFor(change));
    const overlay =
      profile === undefined
        ? undefined
        : resolveOverlayPaths(harnessFieldsOfProfile(profile), profileBase, homedir());
    const discovery = yield* harnessDiscoveryFor(change);
    const resolved = resolveSubagentHarness(discovery, {
      ...(record.harnessKey === undefined ? {} : { pinnedKey: record.harnessKey }),
      ...(profile?.harness === undefined ? {} : { profileHarness: profile.harness }),
      ...(change.subagentHarness === undefined ? {} : { changeKey: change.subagentHarness }),
      defaultKey: harnessDefaultsFor(change).subagents,
      agent: record.harness,
      ...(overlay === undefined ? {} : { overlay }),
    });
    if (Result.isFailure(resolved)) {
      const pinned = record.harnessKey ?? record.profile;
      return yield* badHarness(`harness "${pinned}": ${describeHarnessError(resolved.failure)}`);
    }
    // A subagent's environment is its harness plus the profile's overlay, so it has its own
    // generated directory under the harness's; cleanup still walks the change's state.
    const dir = join(generatedHarnessDir(stateDir(), change.id, resolved.success), "subagents", record.id);
    return yield* generated(change, resolved.success, { dir });
  });

const shell = (): string => process.env.SHELL ?? "/bin/sh";

/** A shell word, quoted for `/bin/sh -c`. */
const shellWord = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The command a harness window runs: the warning line (if any) before Pi, then Pi itself. */
export const piCommand = (warningsLine?: string): string =>
  warningsLine === undefined ? "exec pi" : `printf '%s\\n' ${shellWord(warningsLine)}; exec pi`;

/** Run a command through a shell, printing the warning line first when there is one. */
export const withWarningsLine = (command: readonly string[], warningsLine?: string): readonly string[] =>
  warningsLine === undefined
    ? command
    : [shell(), "-c", `printf '%s\\n' ${shellWord(warningsLine)}; exec ${command.map(shellWord).join(" ")}`];

/** The command a harness window runs: the harness's own agent, with the model opencode applies,
 * and the warning line before it. */
export const harnessWindowCommand = (
  harness: Pick<ResolvedHarness, "agent" | "fields">,
  warningsLine: string | undefined,
): string =>
  harness.agent === "pi"
    ? piCommand(warningsLine)
    : [
        warningsLine === undefined ? "" : `printf '%s\\n' ${shellWord(warningsLine)};`,
        "exec opencode",
        harness.fields.model === undefined ? "" : `--model ${shellWord(harness.fields.model)}`,
      ]
        .filter((part) => part !== "")
        .join(" ");

/** What opens a window: the real host, or a test's capture. */
export type OpenHarnessWindow = (
  changeId: string,
  directory: string,
  command: string,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly harness?: string;
    readonly envDir?: string;
    readonly announce?: { readonly label: string; readonly notify: boolean };
  },
) => Promise<string>;

/** Open the new-terminal dialog's harness window: its own agent, in the chosen directory (the
 * change root for the `change`/`current` sentinels), named after the harness. Returns the
 * registry window id. */
export const openHarnessWindow = (
  change: Change,
  input: OpenHarnessWindowDto,
  open: OpenHarnessWindow = newWindowRunningAsync,
): Effect.Effect<{ readonly window: string }, BadRequestError> =>
  Effect.gen(function* () {
    const discovery = yield* harnessDiscoveryFor(change);
    const byKey = resolveHarnessByKey(discovery, input.harness);
    const resolved = Result.isSuccess(byKey) ? byKey : resolveHarness(discovery, input.harness);
    if (Result.isFailure(resolved)) {
      return yield* badHarness(`harness "${input.harness}": ${describeHarnessError(resolved.failure)}`);
    }
    const harness = resolved.success;
    const launch = yield* generated(change, harness, {});
    // `change` and `current` are selector sentinels, never paths: with no current pane both mean
    // the change root. A literal relative path must never become a pty's cwd.
    const root = changeDir(change);
    // `current` is the active pane's directory, exactly as the shell route resolves it; `change`
    // (and an absent value) is the change root. `envDir` is always the root.
    const directory =
      input.directory === "current"
        ? yield* Effect.promise(() => currentPaneDirectory(change.id, root))
        : input.directory === undefined || input.directory === "change"
          ? root
          : input.directory;
    const command = harnessWindowCommand(harness, launch.warningsLine);
    const window = yield* Effect.tryPromise({
      try: () =>
        open(change.id, directory, command, {
          cwd: directory,
          envDir: root,
          env: launch.env,
          harness: launch.key,
          announce: { label: launch.label, notify: false },
        }),
      catch: (error) => badHarness(error instanceof Error ? error.message : String(error)),
    });
    return { window };
  });
