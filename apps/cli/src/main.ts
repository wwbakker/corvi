/**
 * The Corvi CLI: argv → a typed call on `@corvi/client` → stdout, and an exit code.
 *
 * It is a thin proxy over the running server (`docs/design`'s "applications assemble"): it never
 * touches change files or tmux, so the server stays the single writer and optimistic concurrency
 * keeps working. Everything it can do is also in the page; the CLI is for an agent, a script, or
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
import { ChangeId, type ChangePhase } from "@corvi/contracts/changes";

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
  change show                          this change's record
  change start                         start its work (worktrees, tickets)
  change complete [--force]            merge and close it
  change cancel [--force]              abandon it, keeping what others can see
  change phase <Ideation|Implementation|Verification|Blocked>
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
  subagent wait [<id>] [--any|--all] [--since N]
                                       block until a turn (or a lost window)
  subagent result <id>                 the latest subagent message
  subagent next --subagent <id>        extension-facing: await the next inbound message
  subagent turn --subagent <id> "…"    extension-facing: relay a settled reply

Each group prints its own usage: corvi change, corvi action, corvi subagent.

  --json            machine-readable output (one JSON value)
  --change <id>     the change; defaults to CORVI_CHANGE_ID, then the nearest change.json
  --server <url>    the server; defaults to CORVI_URL, the app's record, then 127.0.0.1:4000

exit codes: 0 ok · 1 failure · 2 usage · 3 no server · 4 refused · 5 lost
`;

/** One group's own usage, printed by a bare `corvi <group>`. The recipes live here — the
 * delegation one under `subagent` is what an agent told to "use subagents" needs to read — so
 * every prompt keeps a pointer and `corvi` itself carries the details. */
export const GROUP_HELP: Readonly<Record<string, string>> = {
  change: `corvi change — this change's record and lifecycle

usage: corvi change <command> [args]

  list                          every change
  show                          this change's record
  start                         start its work (worktrees, tickets)
  complete [--force]            merge and close it
  cancel [--force]              abandon it, keeping what others can see
  phase <Ideation|Implementation|Verification|Blocked>
`,
  action: `corvi action — the actions this change may run, and the files behind them

usage: corvi action <command> [args]

  list                          the actions this change may run (their keys)
  run <key> [--window <id>]     run one

  profile list                  the action files, as written (with their problems)
  profile write <id> --scope <global|workspace> [--workspace <id>] [--from <file>]
                                add or replace one; text from --from, or stdin
  profile delete <id> --scope <global|workspace> [--workspace <id>]
                                remove one

A repository action is a file in the change's checkout — <checkout>/.corvi/actions/<id>.md —
written directly with your own tools; it shows up in 'action list'.
`,
  status: `corvi status — report this host session's agent status

usage: corvi status <working|waiting|clear> [--name <agent>] [--session-name <name>] [--message <text>]

The session id and incarnation come from the environment (CORVI_SESSION_ID,
CORVI_SESSION_INCARNATION); outside a Corvi host session there is nothing to report to.
`,
  subagent: `corvi subagent — persistent subagents for this change

usage: corvi subagent <command> [args]

  profile list                  the profiles this change can run (their keys)
  profile write <id> --scope <global|workspace> [--workspace <id>] [--from <file>]
                                add or replace one; text from --from, or stdin
  profile delete <id> --scope <global|workspace> [--workspace <id>]
                                remove one
  create <profile> [--prompt "…"]
                                create, open and send the first message
  list | show <id>              the change's subagents, and one of them
  open <id> | close <id>        presence only; never starts work
  send <id> "…"                 append a message and deliver it as a turn
  wait [<id>] [--any|--all] [--since N]
                                block until a turn (or a lost window)
  result <id>                   the latest subagent message

To delegate work:

  corvi subagent profile list
  corvi subagent create global:reviewer --prompt "Review the plan and the diff"
  corvi subagent wait <id>      # until it replies (or its window is lost)
  corvi subagent result <id>    # its answer

A profile is one Markdown file (frontmatter: label, harness; body: the initial prompt).
A repository profile is a file in the change's checkout — <checkout>/.corvi/subagents/<id>.md —
written directly; global and workspace profiles go through 'profile write'.

Extension-facing: next --subagent <id>, turn --subagent <id> "…".
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
  change: ["list", "show", "start", "complete", "cancel", "phase"],
  action: ["list", "run", "profile"],
  subagent: ["list", "show", "create", "open", "close", "send", "wait", "result", "next", "turn", "profile"],
  status: ["working", "waiting", "clear"],
};

/** The `profile` subfamilies, checked beside the groups — a typo is a usage error (2) and must
 * not pay a round of probes first (or be reported as "no server"). */
const PROFILE_COMMANDS: readonly string[] = ["list", "write", "delete"];

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
    default:
      throw new CliFailure(
        command === undefined ? "change needs a command: list, show, start, complete, cancel, phase" : `unknown change command: ${command}`,
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
    case "wait": {
      const since = stringFlag(args, "since");
      const mode = boolFlag(args, "all") ? "all" : boolFlag(args, "any") ? "any" : "one";
      const target = rest[0] ?? stringFlag(args, "subagent");
      const result = await client.subagents.wait(id, {
        ...(target === undefined ? {} : { id: target }),
        ...(since === undefined ? {} : { since: Number(since) }),
        ...(mode === "all" ? { all: true } : mode === "any" ? { any: true } : {}),
      });
      emit(io, json, {
        value: result,
        human: (value) => `${value.status}${value.id === undefined ? "" : ` ${value.id}`}`,
      });
      return result.status === "lost" || result.status === "interrupted" ? EXIT.lost : EXIT.ok;
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
      const message = await client.subagents.turn(id, sub, { text }, stringFlag(args, "idempotency-key"));
      emit(io, json, { value: message, human: () => `relayed turn ${message.number}` });
      return EXIT.ok;
    }
    default:
      throw new CliFailure(
        command === undefined
          ? "subagent needs a command: list, show, create, open, close, send, wait, result, next, turn"
          : `unknown subagent command: ${command}`,
        EXIT.usage,
      );
  }
};

/** A file's identity in the key format discovery uses (`global:reviewer`,
 * `workspace:personal:reviewer`), for output that can be pasted back into a command. Only the
 * scopes these commands write exist here: a repository file's key also carries its repository
 * (`repository:orders-api:reviewer`, `@corvi/agents/discovery`), and repository files are
 * written directly, never through this CLI. */
const fileKey = (file: { readonly scope: string; readonly workspace?: string; readonly id: string }): string =>
  `${file.scope}:${file.workspace === undefined ? "" : `${file.workspace}:`}${file.id}`;

/** The file operations `profile write`/`delete` share between the families: the same shape in
 * two DTOs (`@corvi/contracts/actions`, `@corvi/contracts/subagents`), the same API the pages
 * edit through. */
type ProfileFileAt = {
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly id: string;
};
type ProfileFileApi = {
  readonly writeFile: (
    file: ProfileFileAt & { readonly text: string },
  ) => Promise<{ files: readonly { id: string; scope: string; workspace?: string; label?: string }[] }>;
  readonly deleteFile: (ref: ProfileFileAt) => Promise<unknown>;
};

type ProfileTarget = { readonly sub: "write" | "delete" } & ProfileFileAt;

/** The file operation's whole argv — `write`/`delete`, its id, its scope — checked before
 * discovery (`run` calls this beside `validateCommand`): a typo is a usage error (2) and must
 * not pay a round of probes first, or be reported as "no server". `profileFileCommand` then
 * trusts it and does the I/O.
 *
 * The scope is said out loud — never defaulted, because the difference is where a file lands.
 * `repository` is refused with the path instead: those files are the checkout's own, written
 * with your own tools (the same rule the pages hold,
 * `apps/server/src/subagents/server/files.ts`). `--workspace` goes with `--scope workspace`
 * only — the server would refuse the rest anyway, and a usage error here names the flag. */
const profileTarget = (args: ParsedArgs, family: "action" | "subagent"): ProfileTarget => {
  const [sub, id] = args.positionals.slice(2);
  if (sub !== "write" && sub !== "delete") {
    throw new CliFailure(
      sub === undefined ? "profile needs a command: list, write, delete" : `unknown profile command: ${sub}`,
      EXIT.usage,
    );
  }
  if (id === undefined || id === "") throw new CliFailure(`profile ${sub} needs an id`, EXIT.usage);
  const dir = family === "action" ? "actions" : "subagents";
  const where = `<checkout>/.corvi/${dir}/${id}.md`;
  const scope = stringFlag(args, "scope");
  if (scope === undefined) {
    throw new CliFailure(
      `profile ${sub} needs --scope global|workspace — a repository file is written directly, at ${where}`,
      EXIT.usage,
    );
  }
  if (scope === "repository") {
    throw new CliFailure(
      `a repository file is the checkout's own: write ${where} directly — it shows up in corvi ${family} ${family === "action" ? "list" : "profile list"}`,
      EXIT.usage,
    );
  }
  if (scope !== "global" && scope !== "workspace") {
    throw new CliFailure(`--scope takes global or workspace, not ${scope}`, EXIT.usage);
  }
  const workspace = stringFlag(args, "workspace");
  if (scope === "workspace" && (workspace === undefined || workspace === "")) {
    throw new CliFailure("--scope workspace needs --workspace <id>", EXIT.usage);
  }
  if (scope === "global" && workspace !== undefined) {
    throw new CliFailure("--workspace only goes with --scope workspace", EXIT.usage);
  }
  // A write with no text and a terminal in front would hang on stdin for ever — the one failure
  // mode an agent-facing CLI must not have. A piped stdin is still read to its EOF below.
  if (sub === "write" && stringFlag(args, "from") === undefined && process.stdin.isTTY === true) {
    throw new CliFailure("profile write needs the file's text: --from <path>, or pipe it to stdin", EXIT.usage);
  }
  return { sub, scope, ...(workspace === undefined ? {} : { workspace }), id };
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
  family: "action" | "subagent",
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const { sub, ...at } = profileTarget(args, family);
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
  await profileFileCommand(family === "action" ? client.actions : client.subagents, family, args, json, io);
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
 * server that owns one. `change list` is about the server, not a change: an ambient
 * `CORVI_CHANGE_ID` must not constrain which server answers it. */
const needsChange = (positionals: readonly string[]): boolean => {
  const [group, command] = positionals;
  if (group === "change") return command !== "list";
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
      profileTarget(args, checkedGroup);
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
