/**
 * The Corvi CLI: argv → a typed call on `@corvi/client` → stdout, and an exit code.
 *
 * It is a thin proxy over the running server (`docs/design`'s "applications assemble"): it never
 * touches change files or the terminal host, so the server stays the single writer and optimistic
 * concurrency keeps working. Everything it can do is also in the page; the CLI is for an agent, a script, or
 * a person in a checkout.
 *
 * Machine-first: every command takes `--json`, prints one JSON value on success, a JSON error
 * envelope on failure, and chooses an exit code from `./errors.ts`. The human output is a
 * convenience layered on top, never the contract.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ClientError, makeCorviClient, type CorviClient } from "@corvi/client";
import type { CheckoutSpecDto, CreateChangeBodyDto, RepoStateDto } from "@corvi/contracts/api";
import { ChangeId, type BranchPlan, type ChangePhase } from "@corvi/contracts/changes";

import { boolFlag, isKnownFlag, parseArgs, stringFlag, type ParsedArgs } from "./args.ts";
import { resolveChangeId } from "./change-context.ts";
import { clientProbe, resolveServer, serverCandidates } from "./discovery.ts";
import { CliFailure, EXIT } from "./errors.ts";

export type Io = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** The phases `change phase` accepts. `Completed` and `Cancelled` are lifecycle outcomes, reached
 * through `change complete` / `change cancel`, not by setting the state. */
const PHASES: readonly ChangePhase[] = ["Ideation", "Implementation", "Verification", "Blocked"];

const USAGE = `corvi — control a change from the command line

usage: corvi [--json] [--change <id>] [--server <url>] <group> <command> [args]

  change list                          every change
  change create <id> --title <title> [--branch <name>] [--workspace <id>]
                                       make a new idea, then print the next steps
  change show                          this change's record
  change start                         start its work (worktrees, tickets)
  change complete [--force]            merge and close it
  change cancel [--force]              abandon it, keeping what others can see
  change phase <Ideation|Implementation|Verification|Blocked>
  change repository list               the change's repositories, with the names remove takes
  change repository add <path> [--location new|original] [--branch change|current|existing]
                       [--branch-name <name>] [--base <ref>] [--target <ref>] [--force]
                                       add one, or set a changed one up again
  change repository remove <name> [--force]
                                       drop one by the name repository list prints
  action list                          the actions this change may run
  action run <key> [--window <id>]     run one
  action profile list|write|delete     the action files behind them

  status working|waiting|clear [--name N] [--session-name S] [--message M]
                                       this host session's agent status (identity from the pty)

  subagent list                        the change's subagents and their state
  subagent show <id>                   one subagent
  subagent profile list                the profiles this change can run (their keys)
  subagent profile write|delete        add, replace or remove a profile file
  subagent create <profile> [--prompt "…"]
                                       create, open and send the first message
  subagent open <id> | close <id>      presence only; never starts work
  subagent send <id> "…"               append a message and deliver it as a turn
  subagent await [<id>…] [--any|--all]
                                       block until one (or all) can be processed
  subagent result <id>                 the latest subagent message
  subagent next --subagent <id>        extension-facing: await the next inbound message
  subagent turn --subagent <id> [--in-reply-to <n>] "…"
                                       extension-facing: relay a settled reply, naming the
                                       inbound message it answers

Each group prints its own usage: corvi change, corvi action, corvi subagent.

  --json            machine-readable output (one JSON value)
  --change <id>     the change; defaults to CORVI_CHANGE_ID, then the nearest change.json
  --server <url>    the server; defaults to CORVI_URL, the app's record, then 127.0.0.1:4000

exit codes: 0 ok · 1 failure · 2 usage · 3 no server · 4 refused · 5 lost · 6 timeout
`;

/** One group's own usage, printed by a bare `corvi <group>`. The recipes live here — the
 * delegation one under `subagent` is what an agent told to "use subagents" needs to read — so
 * every prompt keeps a pointer and `corvi` itself carries the details. */
export const GROUP_HELP: Readonly<Record<string, string>> = {
  change: `corvi change — this change's record and lifecycle

usage: corvi change <command> [args]

  list                          every change
  create <id> --title <title> [--branch <name>] [--workspace <id>]
                                make a new idea, then print the next steps
  show                          this change's record
  start                         start its work (worktrees, tickets)
  complete [--force]            merge and close it
  cancel [--force]              abandon it, keeping what others can see
  phase <Ideation|Implementation|Verification|Blocked>
  repository list               the repositories, with the names remove takes
  repository add <path> [--location new|original] [--branch change|current|existing]
                 [--branch-name <name>] [--base <ref>] [--target <ref>] [--force]
                                add one, or set a changed one up again
  repository remove <name> [--force]
                                drop one by the name repository list prints
`,
  action: `corvi action — the actions this change may run, and the files behind them

usage: corvi action <command> [args]

  list                          the actions this change may run (their keys)
  run <key> [--window <id>]     run one

  profile list                  the action files, as written (with their problems)
  profile write <id> --scope <global|workspace|repository> [--workspace <id>] [--repository <name>] [--from <file>]
                                add or replace one; text from --from, or stdin
  profile delete <id> --scope <global|workspace|repository> [--workspace <id>] [--repository <name>]
                                remove one

A repository action is a file in the change's checkout — <checkout>/.corvi/actions/<id>.md —
written with --scope repository --repository <name> (or directly with your own tools); it shows
up in 'action list'.
`,
  status: `corvi status — report this host session's agent status

usage: corvi status <working|waiting|clear> [--name <agent>] [--session-name <name>] [--message <text>]

The session id and incarnation come from the environment (CORVI_SESSION_ID,
CORVI_SESSION_INCARNATION); outside a Corvi host session there is nothing to report to.
`,
  subagent: `corvi subagent — persistent subagents for this change

usage: corvi subagent <command> [args]

  profile list                  the profiles this change can run (their keys)
  profile write <id> --scope <global|workspace|repository> [--workspace <id>] [--repository <name>] [--from <file>]
                                add or replace one; text from --from, or stdin
  profile delete <id> --scope <global|workspace|repository> [--workspace <id>] [--repository <name>]
                                remove one
  create <profile> [--prompt "…"]
                                create, open and send the first message
  list | show <id>              the change's subagents, and one of them
  open <id> | close <id>        presence only; never starts work
  send <id> "…"                 append a message and deliver it as a turn
  await [<id>…] [--any|--all]   block until one (or all) can be processed — idle or
                                waiting for input, or a reply for the current turn;
                                after five minutes it answers timeout (exit 6), so you
                                can check in on them and await again
  result <id>                   the latest subagent message

To delegate work:

  corvi subagent profile list
  corvi subagent create global:reviewer --prompt "Review the plan and the diff"
  corvi subagent await <id>     # until it can be processed (or its window is lost)
  corvi subagent result <id>    # its answer

A profile is one Markdown file (frontmatter: label, harness; body: the initial prompt).
A repository profile is a file in the change's checkout — <checkout>/.corvi/subagents/<id>.md —
written with --scope repository --repository <name> (or directly with your own tools).

Extension-facing: next --subagent <id>, turn --subagent <id> [--in-reply-to <n>] "…".
`,
};

type Output<T> = { readonly value: T; readonly human: (value: T) => string };

const emit = <T>(io: Io, json: boolean, output: Output<T>): void => {
  io.out(json ? JSON.stringify(output.value) : output.human(output.value));
};

const requireChange = (changeId: string | undefined): ChangeId => {
  if (changeId === undefined) {
    throw new CliFailure(
      "no change given — pass --change <id>, or run inside a change directory",
      EXIT.usage,
    );
  }
  return ChangeId.make(changeId);
};

/** The command shapes, checked before discovery: a typo is a usage error (2) and must not pay a
 * round of probes first (or be reported as "no server"). */
export const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  change: ["list", "create", "show", "start", "complete", "cancel", "phase", "repository"],
  action: ["list", "run", "profile"],
  subagent: ["list", "show", "create", "open", "close", "send", "await", "result", "next", "turn", "profile"],
  status: ["working", "waiting", "clear"],
};

/** The `profile` subfamilies, checked beside the groups — a typo is a usage error (2) and must
 * not pay a round of probes first (or be reported as "no server"). */
const PROFILE_COMMANDS: readonly string[] = ["list", "write", "delete"];

/** The `change repository` subcommands, checked for the same reason as the profile family. */
const REPOSITORY_COMMANDS: readonly string[] = ["list", "add", "remove"];

const validateCommand = (positionals: readonly string[]): void => {
  const [group, command, sub] = positionals;
  // `Object.hasOwn`, not `in`/indexing: a plain record inherits `toString`, `constructor` and
  // the rest of Object.prototype, and an argv token must never read as a command — or crash
  // with a raw TypeError where the contract says usage (2).
  const commands = group === undefined || !Object.hasOwn(COMMANDS, group) ? undefined : COMMANDS[group];
  if (commands === undefined) throw new CliFailure(`unknown command: ${group ?? ""}`.trim(), EXIT.usage);
  if (command === undefined || !commands.includes(command)) {
    throw new CliFailure(`${group} needs a command: ${commands.join(", ")}`, EXIT.usage);
  }
  if (command === "profile" && sub !== undefined && !PROFILE_COMMANDS.includes(sub)) {
    throw new CliFailure(`unknown profile command: ${sub}`, EXIT.usage);
  }
  if (command === "repository" && sub !== undefined && !REPOSITORY_COMMANDS.includes(sub)) {
    throw new CliFailure(`unknown repository command: ${sub}`, EXIT.usage);
  }
};

const changeCommand = async (
  client: CorviClient,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const [command, ...rest] = args.positionals.slice(1);
  switch (command) {
    case "list": {
      const changes = await client.changes.list();
      emit(io, json, {
        value: changes,
        human: (value) =>
          value.map((change) => `${change.id}\t${change.state ?? "-"}\t${change.title ?? ""}`).join("\n"),
      });
      return;
    }
    case "create": {
      // The whole argv was validated before discovery; this is the one body it produced. No
      // `requireChange`: the command makes a change, so it reads no ambient one.
      const body = createTarget(args);
      const created = await client.changes.create(body);
      // The recipe names where the record now lives, so the caller can write its PLAN.md. The
      // route answers with the directory; the fallback keeps the line readable if it ever does
      // not. The id is the server's own spelling of the created change.
      const dir = created.changeDir ?? "the change's directory";
      const id = created.change.id;
      const next = [
        `write ${dir}/PLAN.md — the change's plan document`,
        `corvi change repository add <path> --change ${id}`,
        `corvi change start --change ${id}`,
      ];
      emit(io, json, {
        value: { ...created, next },
        human: (value) =>
          [`created ${value.change.id} (Ideation)`, "next:", ...value.next.map((line) => `  ${line}`)].join(
            "\n",
          ),
      });
      return;
    }
    case "show": {
      const id = requireChange(changeId);
      const change = await client.changes.read(id);
      emit(io, json, {
        value: change,
        human: (value) =>
          [
            `id:      ${value.id}`,
            `title:   ${value.title ?? ""}`,
            `state:   ${value.state ?? "-"}`,
            `branch:  ${value.branch}`,
            `created: ${value.createdAt}`,
          ].join("\n"),
      });
      return;
    }
    case "start": {
      const id = requireChange(changeId);
      const started = await client.changes.start(id);
      emit(io, json, { value: started, human: () => `started ${id}` });
      return;
    }
    case "complete": {
      const id = requireChange(changeId);
      const completed = await client.changes.complete(id, boolFlag(args, "force") ? { force: true } : undefined);
      emit(io, json, { value: completed, human: () => `completed ${id}` });
      return;
    }
    case "cancel": {
      const id = requireChange(changeId);
      const cancelled = await client.changes.cancel(id, boolFlag(args, "force") ? { force: true } : undefined);
      emit(io, json, { value: cancelled, human: () => `cancelled ${id}` });
      return;
    }
    case "phase": {
      const id = requireChange(changeId);
      const phase = rest[0];
      if (phase === undefined || !PHASES.includes(phase as ChangePhase)) {
        throw new CliFailure(
          `change phase needs one of: ${PHASES.join(", ")}`,
          EXIT.usage,
        );
      }
      const updated = await client.changes.rename(id, { state: phase });
      emit(io, json, {
        value: updated,
        human: () => `${id} is now ${updated.state ?? phase}`,
      });
      return;
    }
    case "repository": {
      const id = requireChange(changeId);
      const target = repositoryTarget(args);
      if (target.sub === "list") {
        const states = await client.changes.repoStates(id);
        emit(io, json, { value: states, human: (value) => value.map(repositoryLine).join("\n") });
        return;
      }
      // The whole set is posted: read what stands, change the one entry, write it back. The
      // server stays the single writer and re-validates every invariant.
      const states = await client.changes.repoStates(id);
      const specs: CheckoutSpecDto[] = states.map((state) => ({
        path: state.path,
        location: state.location,
        branch: state.branch,
        ...(state.base === undefined ? {} : { base: state.base }),
        ...(state.target === undefined ? {} : { target: state.target }),
      }));
      if (target.sub === "remove") {
        const index = states.findIndex((state) => state.name === target.name);
        if (index === -1) {
          throw new CliFailure(
            `no repository named ${target.name} — repository list shows the names`,
            EXIT.refused,
          );
        }
        specs.splice(index, 1);
      } else {
        // The server stores absolute paths; a relative one is the caller's cwd, resolved here.
        const path = resolve(target.path);
        const spec: CheckoutSpecDto = {
          path,
          location: target.location,
          branch: target.branch,
          ...(target.base === undefined ? {} : { base: target.base }),
          ...(target.target === undefined ? {} : { target: target.target }),
        };
        const index = specs.findIndex((existing) => existing.path === path);
        if (index === -1) specs.push(spec);
        else specs[index] = spec;
      }
      const result = await client.changes
        .setRepositories(id, { checkouts: specs, force: boolFlag(args, "force") })
        .catch((error: unknown) => {
          // A 409 with `needsForce` is the server asking about work an edit would discard; its
          // body names the repositories. Without one — a version/format conflict — the server's
          // own message is the right answer, so rethrow it untouched.
          throw repositoryForceRefusal(error) ?? error;
        });
      emit(io, json, {
        value: result,
        human: (value) => {
          // A checkout that failed is printed, but the record was written: exit stays ok.
          const failures = value.provision.filter((entry) => !entry.ok);
          if (failures.length === 0) return `repositories updated for ${id}`;
          return failures
            .map((entry) => `${entry.integration}: ${entry.error ?? entry.detail ?? "failed"}`)
            .join("\n");
        },
      });
      return;
    }
    default:
      throw new CliFailure(
        command === undefined ? "change needs a command: list, create, show, start, complete, cancel, phase, repository" : `unknown change command: ${command}`,
        EXIT.usage,
      );
  }
};

const actionCommand = async (
  client: CorviClient,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const [command, ...rest] = args.positionals.slice(1);
  const id = requireChange(changeId);
  switch (command) {
    case "list": {
      const actions = await client.actions.list(id);
      emit(io, json, {
        value: actions,
        human: (value) =>
          value.map((action) => `${action.key}\t${action.label}`).join("\n"),
      });
      return;
    }
    case "run": {
      const key = rest[0];
      if (key === undefined) throw new CliFailure("action run needs a key", EXIT.usage);
      const window = stringFlag(args, "window");
      const result = await client.actions.run(id, key, window);
      emit(io, json, {
        value: result,
        human: () =>
          `ran ${key}${result.window ? ` in ${result.window}` : ""}${result.submitted ? "" : " (not submitted)"}`,
      });
      return;
    }
    default:
      throw new CliFailure(
        command === undefined ? "action needs a command: list, run" : `unknown action command: ${command}`,
        EXIT.usage,
      );
  }
};

const subagentCommand = async (
  client: CorviClient,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<number> => {
  const [command, ...rest] = args.positionals.slice(1);
  const id = requireChange(changeId);
  const subId = (position = 0): string => {
    const named = stringFlag(args, "subagent") ?? rest[position];
    if (named === undefined || named === "") {
      throw new CliFailure(`${command ?? "this"} needs a subagent id (--subagent <id>, or a positional)`, EXIT.usage);
    }
    return named;
  };
  switch (command) {
    case "list": {
      const instances = await client.subagents.list(id);
      emit(io, json, {
        value: instances,
        human: (value) =>
          value
            .map(
              (instance) =>
                `${instance.id}\t${instance.presence}\t${instance.interrupted ? "interrupted" : instance.activity}${instance.awaitingReply ? "\treply" : ""}`,
            )
            .join("\n"),
      });
      return EXIT.ok;
    }
    case "show": {
      const instance = await client.subagents.read(id, subId());
      emit(io, json, {
        value: instance,
        human: (value) =>
          `${value.id}\t${value.presence}\t${value.interrupted ? "interrupted" : value.activity}`,
      });
      return EXIT.ok;
    }
    case "create": {
      const profile = rest[0];
      if (profile === undefined) throw new CliFailure("subagent create needs a profile key", EXIT.usage);
      const prompt = stringFlag(args, "prompt");
      const instance = await client.subagents.create(
        id,
        { profile, ...(prompt === undefined ? {} : { prompt }) },
        stringFlag(args, "idempotency-key"),
      );
      emit(io, json, { value: instance, human: (value) => `created ${value.id}` });
      return EXIT.ok;
    }
    case "open":
    case "close": {
      const sub = subId();
      const instance =
        command === "open" ? await client.subagents.open(id, sub) : await client.subagents.close(id, sub);
      emit(io, json, { value: instance, human: () => `${command === "open" ? "opened" : "closed"} ${sub}` });
      return EXIT.ok;
    }
    case "send": {
      const named = stringFlag(args, "subagent");
      const sub = subId();
      const text = named === undefined ? rest[1] : rest[0];
      if (text === undefined || text === "") throw new CliFailure("subagent send needs text", EXIT.usage);
      const message = await client.subagents.send(id, sub, { text }, stringFlag(args, "idempotency-key"));
      emit(io, json, { value: message, human: () => `sent to ${sub}` });
      return EXIT.ok;
    }
    case "result": {
      const message = await client.subagents.result(id, subId());
      emit(io, json, { value: message, human: (value) => value?.body ?? "(no reply yet)" });
      return EXIT.ok;
    }
    case "await": {
      const named = stringFlag(args, "subagent");
      const positionalIds = rest.filter((one) => one !== "");
      const ids = positionalIds.length > 0 ? positionalIds : named === undefined ? [] : [named];
      const mode = boolFlag(args, "all") ? "all" : "any";
      const result = await client.subagents.await(id, { ids, ...(mode === "all" ? { all: true } : {}) });
      emit(io, json, {
        value: result,
        human: (value) =>
          `${value.status}${value.id === undefined ? "" : ` ${value.id}`}${value.awaitingReply ? " (reply waiting)" : ""}`,
      });
      return result.status === "lost" || result.status === "interrupted"
        ? EXIT.lost
        : result.status === "timeout"
          ? EXIT.timeout
          : EXIT.ok;
    }
    case "next": {
      const afterRaw = stringFlag(args, "after");
      const after = afterRaw === undefined ? undefined : Number(afterRaw);
      const result = await client.subagents.next(id, subId(), Number.isFinite(after) ? after : undefined);
      emit(io, json, { value: result, human: (value) => value.status });
      return result.status === "interrupted" ? EXIT.lost : EXIT.ok;
    }
    case "turn": {
      const named = stringFlag(args, "subagent");
      const sub = named ?? rest[0];
      const text = named === undefined ? rest[1] : rest[0];
      if (sub === undefined || text === undefined) {
        throw new CliFailure('subagent turn needs --subagent <id> and the reply text', EXIT.usage);
      }
      // `--in-reply-to` must name a positive message number; checked before discovery too, so a
      // bad value is usage (2) and not "no server".
      const inReplyTo = turnInReplyTo(args);
      const message = await client.subagents.turn(
        id,
        sub,
        {
          text,
          ...(inReplyTo === undefined ? {} : { inReplyTo }),
        },
        stringFlag(args, "idempotency-key"),
      );
      emit(io, json, { value: message, human: () => `relayed turn ${message.number}` });
      return EXIT.ok;
    }
    default:
      throw new CliFailure(
        command === undefined
          ? "subagent needs a command: list, show, create, open, close, send, await, result, next, turn"
          : `unknown subagent command: ${command}`,
        EXIT.usage,
      );
  }
};

/** A file's identity in the key format discovery uses (`global:reviewer`,
 * `workspace:personal:reviewer`, `repository:orders-api:reviewer` — `@corvi/agents/discovery`),
 * for output that can be pasted back into a command. */
const fileKey = (file: {
  readonly scope: string;
  readonly workspace?: string;
  readonly repository?: string;
  readonly id: string;
}): string => {
  const origin = file.repository ?? file.workspace;
  return `${file.scope}:${origin === undefined ? "" : `${origin}:`}${file.id}`;
};

/** The file operations `profile write`/`delete` share between the families: the same shape in
 * two DTOs (`@corvi/contracts/actions`, `@corvi/contracts/subagents`), the same API the pages
 * edit through. A repository file is addressed by change and repository, exactly as the
 * change-scoped routes take it. */
type ProfileFileAt = {
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly id: string;
};
type RepositoryTarget = {
  readonly scope: "repository";
  readonly repository: string;
  readonly id: string;
};
type ProfileFileApi = {
  readonly writeFile: (
    file: ProfileFileAt & { readonly text: string },
  ) => Promise<{ files: readonly { id: string; scope: string; workspace?: string; label?: string }[] }>;
  readonly deleteFile: (ref: ProfileFileAt) => Promise<unknown>;
  readonly writeRepositoryFile: (
    changeId: ChangeId,
    file: { readonly repository: string; readonly id: string; readonly text: string },
  ) => Promise<{
    repositories: readonly { repository: string; files: readonly { id: string; label?: string }[] }[];
  }>;
  readonly deleteRepositoryFile: (
    changeId: ChangeId,
    ref: { readonly repository: string; readonly id: string },
  ) => Promise<unknown>;
};

type ProfileTarget = { readonly sub: "write" | "delete" } & (ProfileFileAt | RepositoryTarget);

/** The inbound message number a `subagent turn` answers, from `--in-reply-to`; `undefined` when
 * the flag is absent. Checked before discovery (`run` calls this beside `validateCommand`) and
 * again in the turn case, which trusts it. The arg parser leaves a value that starts with `-`
 * (e.g. `--in-reply-to -3`) as boolean `true` and shifts it into the positionals, so a present
 * flag that is not a string is a usage error rather than a silent change of the reply text. */
const turnInReplyTo = (args: ParsedArgs): number | undefined => {
  if (!args.flags.has("in-reply-to")) return undefined;
  const raw = stringFlag(args, "in-reply-to");
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new CliFailure("--in-reply-to needs a positive message number", EXIT.usage);
  }
  return Number(raw);
};

/** The file operation's whole argv — `write`/`delete`, its id, its scope — checked before
 * discovery (`run` calls this beside `validateCommand`): a typo is a usage error (2) and must
 * not pay a round of probes first, or be reported as "no server". `profileFileCommand` then
 * trusts it and does the I/O.
 *
 * The scope is said out loud — never defaulted, because the difference is where a file lands.
 * `repository` is one of the change's checkouts (named with `--repository`; a change is
 * required), written through the change-scoped routes like every other repository file.
 * `--workspace` goes with `--scope workspace` only — the server would refuse the rest anyway,
 * and a usage error here names the flag. */
const profileTarget = (args: ParsedArgs): ProfileTarget => {
  const [sub, id] = args.positionals.slice(2);
  if (sub !== "write" && sub !== "delete") {
    throw new CliFailure(
      sub === undefined ? "profile needs a command: list, write, delete" : `unknown profile command: ${sub}`,
      EXIT.usage,
    );
  }
  if (id === undefined || id === "") throw new CliFailure(`profile ${sub} needs an id`, EXIT.usage);
  // A write with no text and a terminal in front would hang on stdin for ever — the one failure
  // mode an agent-facing CLI must not have. A piped stdin is still read to its EOF below.
  if (sub === "write" && stringFlag(args, "from") === undefined && process.stdin.isTTY === true) {
    throw new CliFailure("profile write needs the file's text: --from <path>, or pipe it to stdin", EXIT.usage);
  }
  const scope = stringFlag(args, "scope");
  const workspace = stringFlag(args, "workspace");
  const repository = stringFlag(args, "repository");
  if (scope === "repository") {
    if (repository === undefined || repository === "") {
      throw new CliFailure("--scope repository needs --repository <name>", EXIT.usage);
    }
    if (workspace !== undefined) {
      throw new CliFailure("--workspace only goes with --scope workspace", EXIT.usage);
    }
    return { sub, scope: "repository", repository, id };
  }
  if (scope !== "global" && scope !== "workspace") {
    throw new CliFailure(
      scope === undefined
        ? "profile needs --scope global|workspace|repository"
        : `--scope takes global, workspace or repository, not ${scope}`,
      EXIT.usage,
    );
  }
  if (repository !== undefined) {
    throw new CliFailure("--repository only goes with --scope repository", EXIT.usage);
  }
  if (scope === "workspace" && (workspace === undefined || workspace === "")) {
    throw new CliFailure("--scope workspace needs --workspace <id>", EXIT.usage);
  }
  if (scope === "global" && workspace !== undefined) {
    throw new CliFailure("--workspace only goes with --scope workspace", EXIT.usage);
  }
  return { sub, scope, ...(workspace === undefined ? {} : { workspace }), id };
};

/** `change create`'s whole argv, checked before discovery (`run` calls this beside
 * `profileTarget`, and the command case reuses it as the body): a malformed invocation is a
 * usage error (2) and must not pay a round of probes first, or be reported as "no server".
 * The change is always created as an idea; its repositories are added afterwards. */
const createTarget = (args: ParsedArgs): CreateChangeBodyDto => {
  const id = args.positionals[2];
  if (id === undefined || id === "") {
    throw new CliFailure("change create needs an id", EXIT.usage);
  }
  const title = stringFlag(args, "title");
  if (title === undefined || title === "") {
    throw new CliFailure("change create needs --title <title>", EXIT.usage);
  }
  const branch = stringFlag(args, "branch");
  const workspace = stringFlag(args, "workspace");
  // Empty flags are absent, not empty strings: the server should default them, not record blank.
  return {
    id,
    title,
    state: "Ideation",
    ...(branch === undefined || branch === "" ? {} : { branch }),
    ...(workspace === undefined || workspace === "" ? {} : { workspace }),
  };
};

/** The `change repository` subfamily, checked before discovery (`run` calls this beside
 * `createTarget`): a typo or a bad flag pairing is a usage error (2) and must not pay a round of
 * probes first, or be reported as "no server". The combination rules mirror
 * `checkoutSpecProblem`: a new worktree cannot take the branch a source checkout has checked
 * out, an `existing` branch must be named, and a name only goes with `existing`. */
type RepositoryCommand =
  | { readonly sub: "list" }
  | {
      readonly sub: "add";
      readonly path: string;
      readonly location: CheckoutSpecDto["location"];
      readonly branch: BranchPlan;
      readonly base?: string;
      readonly target?: string;
    }
  | { readonly sub: "remove"; readonly name: string };

const repositoryTarget = (args: ParsedArgs): RepositoryCommand => {
  const sub = args.positionals[2];
  if (sub !== "list" && sub !== "add" && sub !== "remove") {
    throw new CliFailure(
      sub === undefined
        ? "change repository needs a command: list, add, remove"
        : `unknown repository command: ${sub}`,
      EXIT.usage,
    );
  }
  if (sub === "list") return { sub };
  if (sub === "remove") {
    const name = args.positionals[3];
    if (name === undefined || name === "") {
      throw new CliFailure("change repository remove needs a name (repository list shows them)", EXIT.usage);
    }
    return { sub, name };
  }
  const path = args.positionals[3];
  if (path === undefined || path === "") {
    throw new CliFailure("change repository add needs a path", EXIT.usage);
  }
  const location = stringFlag(args, "location") ?? "new";
  if (location !== "new" && location !== "original") {
    throw new CliFailure(`--location takes new or original, not ${location}`, EXIT.usage);
  }
  const branch = stringFlag(args, "branch") ?? "change";
  if (branch !== "change" && branch !== "current" && branch !== "existing") {
    throw new CliFailure(`--branch takes change, current or existing, not ${branch}`, EXIT.usage);
  }
  const branchName = stringFlag(args, "branch-name");
  if (branch === "existing") {
    if (branchName === undefined || branchName.trim() === "") {
      throw new CliFailure("--branch existing needs --branch-name <name>", EXIT.usage);
    }
  } else if (branchName !== undefined) {
    throw new CliFailure("--branch-name only goes with --branch existing", EXIT.usage);
  }
  if (location === "new" && branch === "current") {
    throw new CliFailure(
      "a new worktree cannot use the branch a source checkout has checked out",
      EXIT.usage,
    );
  }
  const base = stringFlag(args, "base");
  const target = stringFlag(args, "target");
  return {
    sub,
    path,
    location,
    branch: branch === "existing" ? { kind: "existing", name: branchName!.trim() } : { kind: branch },
    ...(base === undefined || base === "" ? {} : { base }),
    ...(target === undefined || target === "" ? {} : { target }),
  };
};

/** How one repository renders in `repository list`: its name (what `remove` takes), where its
 * checkout lives, its branch plan, and the two branch refs. */
const repositoryLine = (state: RepoStateDto): string => {
  const branch = state.branch.kind === "existing" ? `existing:${state.branch.name}` : state.branch.kind;
  return [state.name, state.location, branch, state.base ?? "-", state.target ?? "-"].join("\t");
};

/** The repository edit's 409, translated when it is the server's force question. A body with a
 * non-empty `needsForce` names the checkouts an edit would tear down (an add that changes a spec
 * asks too, not only a remove), so the answer is a refusal saying `--force`. Any other 409 — a
 * record from a newer Corvi, a conflicting edit — carries no `needsForce`; `undefined` hands the
 * original error back so `report` keeps the server's own message and status. */
export const repositoryForceRefusal = (error: unknown): CliFailure | undefined => {
  if (!(error instanceof ClientError) || error.status !== 409) return undefined;
  const needsForce = (error.body as { needsForce?: unknown } | undefined)?.needsForce;
  if (!Array.isArray(needsForce) || needsForce.length === 0) return undefined;
  return new CliFailure(
    `${needsForce.join(", ")} would discard work nobody else has — rerun with --force`,
    EXIT.refused,
  );
};

/** The file's text: `--from <path>`, or stdin when it is piped in. */
const profileText = async (args: ParsedArgs): Promise<string> => {
  const from = stringFlag(args, "from");
  const text = from === undefined ? await readStdin() : await readFile(from, "utf8").catch(() => undefined);
  if (text === undefined) throw new CliFailure(`cannot read ${from ?? "stdin"}`, EXIT.usage);
  if (text.trim() === "") {
    throw new CliFailure("profile write needs the file's text: --from <path>, or pipe it to stdin", EXIT.usage);
  }
  return text;
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
};

/** `profile write` and `profile delete`, the same for both families. A file that does not parse
 * is a refusal (4) carrying the reasons — the server checks before it writes. */
const profileFileCommand = async (
  api: ProfileFileApi,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const { sub, ...at } = profileTarget(args);
  if (at.scope === "repository") {
    // A repository file is one checkout's own: the change names the checkout, the repository
    // name its block — the same address the change-scoped routes take.
    const change = requireChange(changeId);
    const ref = { repository: at.repository, id: at.id };
    if (sub === "delete") {
      await api.deleteRepositoryFile(change, ref);
      emit(io, json, { value: at, human: (value) => `deleted ${fileKey(value)}` });
      return;
    }
    await api.writeRepositoryFile(change, { ...ref, text: await profileText(args) });
    emit(io, json, { value: at, human: (value) => `wrote ${fileKey(value)}` });
    return;
  }
  const { scope, workspace, id } = at;
  if (sub === "delete") {
    await api.deleteFile(at);
    emit(io, json, { value: at, human: (value) => `deleted ${fileKey(value)}` });
    return;
  }
  const text = await profileText(args);
  const answer = await api.writeFile({ ...at, text });
  const written = answer.files.find(
    (file) => file.id === id && file.scope === scope && file.workspace === workspace,
  );
  emit(io, json, {
    value: { ...at, ...(written?.label === undefined ? {} : { label: written.label }) },
    human: (value) => `wrote ${fileKey(value)}`,
  });
};

/** `profile`, shared by both groups: a bare one prints the family's help (the recipes live in
 * `GROUP_HELP`), `list` is discovery for subagents and the files for actions, and `write`/
 * `delete` are the file operations above. Dispatch routes it here before the group commands,
 * so it never pays their `requireChange`. */
const profileCommand = async (
  client: CorviClient,
  family: "action" | "subagent",
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const [sub] = args.positionals.slice(2);
  if (sub === undefined) {
    io.out(GROUP_HELP[family] ?? "");
    return;
  }
  if (sub === "list") {
    if (family === "subagent") {
      const discovery = await client.subagents.profiles(requireChange(changeId));
      emit(io, json, {
        value: discovery,
        human: (value) =>
          [
            ...value.profiles.map((profile) => `${profile.key}\t${profile.harness}\t${profile.label}`),
            ...value.skipped.map((file) => `${file.key}\t(skipped: ${file.reasons.join("; ")})`),
          ].join("\n"),
      });
      return;
    }
    const listed = await client.actions.files();
    emit(io, json, {
      value: listed,
      human: (value) =>
        value.files
          .map(
            (file) =>
              `${fileKey(file)}\t${file.label ?? ""}${file.problems === undefined ? "" : `\t${file.problems.join("; ")}`}`,
          )
          .join("\n"),
    });
    return;
  }
  await profileFileCommand(family === "action" ? client.actions : client.subagents, changeId, args, json, io);
};

const statusCommand = async (
  client: CorviClient,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const status = args.positionals[1];
  if (status !== "working" && status !== "waiting" && status !== "clear") {
    throw new CliFailure("status needs working, waiting or clear", EXIT.usage);
  }
  // Identity is the pty environment the host seeded. No session is a clear failure, not a silent
  // no-op: a reporter that cannot report should say so.
  const sessionId = process.env.CORVI_SESSION_ID;
  const rawIncarnation = process.env.CORVI_SESSION_INCARNATION;
  const incarnation = rawIncarnation === undefined ? NaN : Number(rawIncarnation);
  if (sessionId === undefined || sessionId === "" || !Number.isInteger(incarnation) || incarnation < 0) {
    throw new CliFailure(
      "no Corvi session: CORVI_SESSION_ID and CORVI_SESSION_INCARNATION are not set (run this inside a Corvi terminal)",
      EXIT.failure,
    );
  }
  const name = stringFlag(args, "name");
  const sessionName = stringFlag(args, "session-name");
  const message = stringFlag(args, "message");
  await client.terminals.setStatus({
    sessionId,
    incarnation,
    status,
    ...(name === undefined ? {} : { name }),
    ...(sessionName === undefined ? {} : { sessionName }),
    ...(message === undefined ? {} : { message }),
  });
  emit(io, json, { value: { ok: true, status }, human: () => `status ${status}` });
};

const dispatch = async (
  client: CorviClient,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<number> => {
  const [group, command] = args.positionals;
  if ((group === "action" || group === "subagent") && command === "profile") {
    await profileCommand(client, group, changeId, args, json, io);
    return EXIT.ok;
  }
  if (group === "change") return changeCommand(client, changeId, args, json, io).then(() => EXIT.ok);
  if (group === "action") return actionCommand(client, changeId, args, json, io).then(() => EXIT.ok);
  if (group === "subagent") return subagentCommand(client, changeId, args, json, io);
  if (group === "status") return statusCommand(client, args, json, io).then(() => EXIT.ok);
  throw new CliFailure(`unknown command: ${group}`, EXIT.usage);
};

const fail = (
  io: Io,
  json: boolean,
  message: string,
  exitCode: number,
  status?: number,
  body?: unknown,
): number => {
  io.err(
    json
      ? JSON.stringify({
          error: message,
          exitCode,
          ...(status === undefined ? {} : { status }),
          ...(body === undefined ? {} : { body }),
        })
      : message,
  );
  return exitCode;
};

const report = (error: unknown, io: Io, json: boolean): number => {
  if (error instanceof CliFailure) return fail(io, json, error.message, error.exitCode);
  if (error instanceof ClientError) {
    const refused = error.status === 400 || error.status === 404 || error.status === 409;
    return fail(
      io,
      json,
      error.message,
      refused ? EXIT.refused : EXIT.failure,
      error.status,
      error.body,
    );
  }
  return fail(io, json, error instanceof Error ? error.message : String(error), EXIT.failure);
};

/** Whether a command operates on a change, and therefore whether discovery should prefer the
 * server that owns one. `change list` and `change create` are about the server, not a change: an
 * ambient `CORVI_CHANGE_ID` must not constrain which server answers them. */
export const needsChange = (positionals: readonly string[]): boolean => {
  const [group, command] = positionals;
  if (group === "change") return command !== "list" && command !== "create";
  if (group === "action") return true;
  if (group === "subagent") return true;
  return false;
};

/**
 * Run one command line. Exported rather than only run at import: the tests drive it in-process
 * with a captured `Io`, and the entry guard below is the only place that touches `process`.
 */
export const run = async (
  argv: readonly string[],
  io: Io,
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<number> => {
  let json = false;
  try {
    const env = options.env ?? process.env;
    const args = parseArgs(argv);
    json = boolFlag(args, "json");
    if (boolFlag(args, "help") || args.positionals.length === 0) {
      // `corvi subagent --help` is that group's own usage, the same as bare `corvi subagent`:
      // the habitual form must teach as well as the bare one.
      const [asked] = args.positionals;
      io.out(asked !== undefined && Object.hasOwn(GROUP_HELP, asked) ? GROUP_HELP[asked]! : USAGE);
      return EXIT.ok;
    }
    for (const name of args.flags.keys()) {
      if (!isKnownFlag(name)) throw new CliFailure(`unknown flag: --${name}`, EXIT.usage);
    }
    // A bare group — or a bare `profile` subfamily — prints its own usage: the recipes live in
    // GROUP_HELP, so a prompt can carry a pointer and `corvi` carries the details. Help before
    // discovery, like every other usage answer.
    const [bare, bareCommand] = args.positionals;
    const bareFamily = bare === "action" || bare === "subagent" ? bare : undefined;
    if (
      bare !== undefined &&
      ((args.positionals.length === 1 && Object.hasOwn(GROUP_HELP, bare)) ||
        (args.positionals.length === 2 && bareCommand === "profile" && bareFamily !== undefined))
    ) {
      io.out(GROUP_HELP[bare] ?? "");
      return EXIT.ok;
    }
    validateCommand(args.positionals);
    // The profile file commands' own argv, checked here for the same reason as the command
    // shapes: a typo is a usage error (2) before any probe, never "no server".
    const [checkedGroup, checkedCommand, checkedSub] = args.positionals;
    if (
      (checkedGroup === "action" || checkedGroup === "subagent") &&
      checkedCommand === "profile" &&
      (checkedSub === "write" || checkedSub === "delete")
    ) {
      profileTarget(args);
    }
    // `subagent turn`'s own flag, checked here for the same reason: a bad `--in-reply-to` is
    // usage (2) before any probe, never "no server".
    if (checkedGroup === "subagent" && checkedCommand === "turn") {
      turnInReplyTo(args);
    }
    // `change create`'s body, checked here for the same reason: a missing id or title is usage
    // (2) before any probe, never "no server".
    if (checkedGroup === "change" && checkedCommand === "create") {
      createTarget(args);
    }
    // The repository family's own argv, checked here too: a bad location/branch pairing is usage
    // (2) before any probe.
    if (checkedGroup === "change" && checkedCommand === "repository") {
      repositoryTarget(args);
    }
    const changeId = await resolveChangeId({
      flag: stringFlag(args, "change"),
      env: env.CORVI_CHANGE_ID,
      cwd: options.cwd ?? process.cwd(),
    });
    const candidates = await serverCandidates({
      url: stringFlag(args, "server"),
      envUrl: env.CORVI_URL,
      env,
    });
    const server = await resolveServer({
      candidates,
      changeId: needsChange(args.positionals) ? changeId : undefined,
      probe: clientProbe(),
    });
    const client = makeCorviClient({ baseUrl: server.url });
    return await dispatch(client, changeId, args, json, io);
  } catch (error) {
    return report(error, io, json);
  }
};

const isEntry = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
};

if (isEntry()) {
  process.exit(
    await run(process.argv.slice(2), {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
}
