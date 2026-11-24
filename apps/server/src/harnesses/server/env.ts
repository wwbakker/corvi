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
  describeHarnessProfileError,
  resolveHarnessProfile,
  resolveHarnessProfileByKey,
  type HarnessProfileWarning,
  type ResolvedHarnessProfile,
} from "@corvi/agents/harness-profile-discovery";
import {
  generatedEnvironmentDir,
  harnessProfileScopeRoot,
  resolveOverlayPaths,
} from "@corvi/agents/environment-generation";
import { discoverSubagentProfiles, generateEnvironment } from "@corvi/agents/node";
import { harnessProfileFieldsOf } from "@corvi/agents/subagent-profile";
import type { SubagentRecord } from "@corvi/agents/instance";
import type { OpenHarnessWindowDto } from "@corvi/contracts/harness-profiles";
import { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import { stateDir } from "@corvi/configuration/node";
import { changeDir } from "../../change/server/index.ts";
import { fileRootsFor } from "../../capabilities/fileRoots.ts";
import { currentPaneDirectory, newWindowRunningAsync } from "../../terminals/server/windows.ts";
import {
  harnessProfileDiscoveryFor,
  harnessProfileScopeBaseFor,
  harnessProfileScopeRootsFor,
  resolveSelection,
  resolveSubagentHarnessProfile,
  subagentRecordHarnessInput,
  selectedHarnessProfileKey,
} from "./selection.ts";

/** One pane's generated environment. A non-Pi harness has no generated directory and an empty
 * environment: opencode keeps today's behavior. */
export type EnvironmentLaunch = {
  readonly dir?: string;
  readonly env: Record<string, string>;
  /** The discovery key, what a window records so two same-labelled harnesses stay distinct. */
  readonly key: string;
  readonly label: string;
  /** The one line to print before Pi starts, when there is a warning. */
  readonly warningsLine?: string;
};

const badHarness = (message: string): BadRequestError => new BadRequestError({ message });

/** One line for the pane: every warning, joined, with the harness profile it belongs to. */
export const warningsLineOf = (
  label: string,
  warnings: readonly HarnessProfileWarning[],
): string | undefined =>
  warnings.length === 0
    ? undefined
    : `harness profile "${label}": ${warnings.map((warning) => warning.message).join("; ")}`;

/** The Corvi log: one line per launch that had warnings, so a pane's broken environment is
 * findable after the fact. */
const logWarnings = (label: string, warnings: readonly HarnessProfileWarning[]): Effect.Effect<void> =>
  Effect.sync(() => {
    const line = warningsLineOf(label, warnings);
    if (line !== undefined) console.error(line);
  });

const generated = (
  change: Change,
  resolved: ResolvedHarnessProfile,
  options: { readonly dir?: string },
): Effect.Effect<EnvironmentLaunch, BadRequestError> =>
  Effect.gen(function* () {
    // opencode has no generated Pi environment: only its model applies, and its launch keeps the
    // old behavior. Warnings still reach the log and the pane.
    if (resolved.harness !== "pi") {
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
    const scopeBase = yield* harnessProfileScopeBaseFor(change, resolved);
    const generatedEnvironment = yield* generateEnvironment({
      stateDir: stateDir(),
      changeId: change.id,
      harnessProfile: resolved,
      ...(scopeBase === undefined ? {} : { scopeBase }),
      ...(options.dir === undefined ? {} : { dir: options.dir }),
    }).pipe(Effect.mapError((error) => badHarness(error.message)));
    const warningsLine = warningsLineOf(generatedEnvironment.view.label, generatedEnvironment.view.warnings);
    yield* logWarnings(generatedEnvironment.view.label, generatedEnvironment.view.warnings);
    return {
      dir: generatedEnvironment.dir,
      env: { PI_CODING_AGENT_DIR: generatedEnvironment.dir },
      key: generatedEnvironment.view.key,
      label: generatedEnvironment.view.label,
      ...(warningsLine === undefined ? {} : { warningsLine }),
    };
  });

/** The environment a shell or command pane of this change starts with: its user harness. */
export const userHarnessProfileLaunch = (change: Change): Effect.Effect<EnvironmentLaunch, BadRequestError> =>
  Effect.gen(function* () {
    const discovery = yield* harnessProfileDiscoveryFor(change);
    const resolved = resolveSelection(change, discovery, "user");
    if (Result.isFailure(resolved)) {
      return yield* badHarness(
        `harness profile "${selectedHarnessProfileKey(change, "user")}": ${describeHarnessProfileError(resolved.failure)}`,
      );
    }
    return yield* generated(change, resolved.success, {});
  });

/** The environment for a named harness key, as the new-terminal dialog selects one. */
export const harnessProfileLaunchByKey = (
  change: Change,
  key: string,
): Effect.Effect<EnvironmentLaunch, BadRequestError> =>
  Effect.gen(function* () {
    const discovery = yield* harnessProfileDiscoveryFor(change);
    const resolved = resolveHarnessProfileByKey(discovery, key);
    if (Result.isFailure(resolved)) {
      return yield* badHarness(`harness profile "${key}": ${describeHarnessProfileError(resolved.failure)}`);
    }
    return yield* generated(change, resolved.success, {});
  });

/** A subagent's environment: the profile it is based on (or the pin it was created with), with
 * the profile's current harness fields overlaid. A pinned profile that disappeared is a clear
 * refusal. A default that runs another harness than the profile asks for falls back to that
 * harness's built-in profile, with a note in the Corvi log. */
export const subagentHarnessProfileLaunch = (
  change: Change,
  record: Pick<
    SubagentRecord,
    "id" | "label" | "profile" | "harness" | "harnessProfileKey" | "harnessProfileFrom"
  >,
): Effect.Effect<EnvironmentLaunch, BadRequestError> =>
  Effect.gen(function* () {
    const profiles = yield* Effect.flatMap(fileRootsFor(change, "subagents"), discoverSubagentProfiles);
    const found = profiles.profiles.find((entry) => entry.key === record.profile);
    const profile = found?.profile;
    const profileBase =
      found === undefined
        ? undefined
        : harnessProfileScopeRoot(found, yield* harnessProfileScopeRootsFor(change));
    const overlay =
      profile === undefined
        ? undefined
        : resolveOverlayPaths(harnessProfileFieldsOf(profile), profileBase, homedir());
    const discovery = yield* harnessProfileDiscoveryFor(change);
    const decision = resolveSubagentHarnessProfile({
      change,
      discovery,
      ...(profile === undefined ? {} : { profile }),
      ...subagentRecordHarnessInput(record),
      ...(overlay === undefined ? {} : { overlay }),
    });
    if (Result.isFailure(decision)) {
      const pinned = record.harnessProfileKey ?? record.profile;
      return yield* badHarness(
        `harness profile "${pinned}": ${describeHarnessProfileError(decision.failure)}`,
      );
    }
    if (decision.success.note !== undefined)
      console.error(`subagent "${record.label}": ${decision.success.note}`);
    // A subagent's environment is its harness profile plus the profile's overlay, so it has its
    // own generated directory under the profile's; cleanup still walks the change's state.
    const dir = join(
      generatedEnvironmentDir(stateDir(), change.id, decision.success.resolved),
      "subagents",
      record.id,
    );
    return yield* generated(change, decision.success.resolved, { dir });
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

/** The command a harness window runs: the profile's program, with the model opencode applies,
 * and the warning line before it. */
export const harnessWindowCommand = (
  harnessProfile: Pick<ResolvedHarnessProfile, "harness" | "fields">,
  warningsLine: string | undefined,
): string =>
  harnessProfile.harness === "pi"
    ? piCommand(warningsLine)
    : [
        warningsLine === undefined ? "" : `printf '%s\\n' ${shellWord(warningsLine)};`,
        "exec opencode",
        harnessProfile.fields.model === undefined ? "" : `--model ${shellWord(harnessProfile.fields.model)}`,
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
    readonly intent?: "activate" | "background";
    readonly announce?: { readonly label: string; readonly notify: boolean };
  },
) => Promise<string>;

/** Open the new-terminal dialog's harness window: the profile's program, in the chosen directory (the
 * change root for the `change`/`current` sentinels), named after the harness. Returns the
 * registry window id. */
export const openHarnessWindow = (
  change: Change,
  input: OpenHarnessWindowDto,
  open: OpenHarnessWindow = newWindowRunningAsync,
): Effect.Effect<{ readonly window: string }, BadRequestError> =>
  Effect.gen(function* () {
    const discovery = yield* harnessProfileDiscoveryFor(change);
    const byKey = resolveHarnessProfileByKey(discovery, input.harnessProfile);
    const resolved = Result.isSuccess(byKey) ? byKey : resolveHarnessProfile(discovery, input.harnessProfile);
    if (Result.isFailure(resolved)) {
      return yield* badHarness(
        `harness profile "${input.harnessProfile}": ${describeHarnessProfileError(resolved.failure)}`,
      );
    }
    const harnessProfile = resolved.success;
    const launch = yield* generated(change, harnessProfile, {});
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
    const command = harnessWindowCommand(harnessProfile, launch.warningsLine);
    const window = yield* Effect.tryPromise({
      try: () =>
        open(change.id, directory, command, {
          cwd: directory,
          envDir: root,
          env: launch.env,
          harness: launch.key,
          // A harness window is the user's terminal: it takes the active tab, and its label names
          // it rather than asking for attention.
          intent: "activate",
          announce: { label: launch.label, notify: false },
        }),
      catch: (error) => badHarness(error instanceof Error ? error.message : String(error)),
    });
    return { window };
  });
