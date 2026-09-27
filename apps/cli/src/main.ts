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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ClientError, makeChangesClient, type ChangesClient } from "@corvi/client";
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

  subagent list                        the change's subagents and their state
  subagent show <id>                   one subagent
  subagent create <profile> [--prompt "…"]
                                       create, open and send the first message
  subagent open <id> | close <id>      presence only; never starts work
  subagent send <id> "…"               append a message and deliver it as a turn
  subagent wait [<id>] [--any|--all] [--since N]
                                       block until a turn (or a lost window)
  subagent result <id>                 the latest subagent message
  subagent next --subagent <id>        extension-facing: await the next inbound message
  subagent turn --subagent <id> "…"    extension-facing: relay a settled reply

  --json            machine-readable output (one JSON value)
  --change <id>     the change; defaults to CORVI_CHANGE_ID, then the nearest change.json
  --server <url>    the server; defaults to CORVI_URL, the app's record, then 127.0.0.1:4000

exit codes: 0 ok · 1 failure · 2 usage · 3 no server · 4 refused · 5 lost
`;

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
const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  change: ["list", "show", "start", "complete", "cancel", "phase"],
  action: ["list", "run"],
  subagent: ["list", "show", "create", "open", "close", "send", "wait", "result", "next", "turn"],
};

const validateCommand = (positionals: readonly string[]): void => {
  const [group, command] = positionals;
  const commands = group === undefined ? undefined : COMMANDS[group];
  if (commands === undefined) throw new CliFailure(`unknown command: ${group ?? ""}`.trim(), EXIT.usage);
  if (command === undefined || !commands.includes(command)) {
    throw new CliFailure(`${group} needs a command: ${commands.join(", ")}`, EXIT.usage);
  }
};

const changeCommand = async (
  client: ChangesClient,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const [command, ...rest] = args.positionals.slice(1);
  switch (command) {
    case "list": {
      const changes = await client.list();
      emit(io, json, {
        value: changes,
        human: (value) =>
          value.map((change) => `${change.id}\t${change.state ?? "-"}\t${change.title ?? ""}`).join("\n"),
      });
      return;
    }
    case "show": {
      const id = requireChange(changeId);
      const change = await client.read(id);
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
      const started = await client.start(id);
      emit(io, json, { value: started, human: () => `started ${id}` });
      return;
    }
    case "complete": {
      const id = requireChange(changeId);
      const completed = await client.complete(id, boolFlag(args, "force") ? { force: true } : undefined);
      emit(io, json, { value: completed, human: () => `completed ${id}` });
      return;
    }
    case "cancel": {
      const id = requireChange(changeId);
      const cancelled = await client.cancel(id, boolFlag(args, "force") ? { force: true } : undefined);
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
      const updated = await client.rename(id, { state: phase });
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
  client: ChangesClient,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<void> => {
  const [command, ...rest] = args.positionals.slice(1);
  const id = requireChange(changeId);
  switch (command) {
    case "list": {
      const actions = await client.terminalActions(id);
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
      const result = await client.runAction(id, key, window);
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
  client: ChangesClient,
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
      const instances = await client.subagents(id);
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
      const instance = await client.subagent(id, subId());
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
      const instance = await client.createSubagent(
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
        command === "open" ? await client.openSubagent(id, sub) : await client.closeSubagent(id, sub);
      emit(io, json, { value: instance, human: () => `${command === "open" ? "opened" : "closed"} ${sub}` });
      return EXIT.ok;
    }
    case "send": {
      const named = stringFlag(args, "subagent");
      const sub = subId();
      const text = named === undefined ? rest[1] : rest[0];
      if (text === undefined || text === "") throw new CliFailure("subagent send needs text", EXIT.usage);
      const message = await client.sendSubagent(id, sub, { text }, stringFlag(args, "idempotency-key"));
      emit(io, json, { value: message, human: () => `sent to ${sub}` });
      return EXIT.ok;
    }
    case "result": {
      const message = await client.subagentResult(id, subId());
      emit(io, json, { value: message, human: (value) => value?.body ?? "(no reply yet)" });
      return EXIT.ok;
    }
    case "wait": {
      const since = stringFlag(args, "since");
      const mode = boolFlag(args, "all") ? "all" : boolFlag(args, "any") ? "any" : "one";
      const target = rest[0] ?? stringFlag(args, "subagent");
      const result = await client.waitSubagent(id, {
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
      const result = await client.nextSubagent(id, subId(), Number.isFinite(after) ? after : undefined);
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
      const message = await client.subagentTurn(id, sub, { text }, stringFlag(args, "idempotency-key"));
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

const dispatch = async (
  client: ChangesClient,
  changeId: string | undefined,
  args: ParsedArgs,
  json: boolean,
  io: Io,
): Promise<number> => {
  const [group] = args.positionals;
  if (group === "change") return changeCommand(client, changeId, args, json, io).then(() => EXIT.ok);
  if (group === "action") return actionCommand(client, changeId, args, json, io).then(() => EXIT.ok);
  if (group === "subagent") return subagentCommand(client, changeId, args, json, io);
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
      io.out(USAGE);
      return EXIT.ok;
    }
    for (const name of args.flags.keys()) {
      if (!isKnownFlag(name)) throw new CliFailure(`unknown flag: --${name}`, EXIT.usage);
    }
    validateCommand(args.positionals);
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
    const client = makeChangesClient({ baseUrl: server.url });
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
