/**
 * The smallest argv parser the CLI needs: long flags with an optional `--flag=value` or
 * `--flag value` form, everything else a positional. No short flags and no sub-parser library —
 * the surface is small enough that a dependency would be larger than the thing it replaces.
 */

export type ParsedArgs = {
  readonly positionals: readonly string[];
  /** Flags in the order they were seen, so a repeated flag keeps its last value. */
  readonly flags: ReadonlyMap<string, string | boolean>;
};

/** The flags that take a value. Everything else is boolean, so `--json change list` cannot read
 * "change" as the value of "json". One small list beats a parser that guesses. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "change",
  "server",
  "window",
  "prompt",
  "subagent",
  "after",
  "in-reply-to",
  "turn",
  "idempotency-key",
  "scope",
  "workspace",
  "repository",
  "from",
  "name",
  "session-name",
  "message",
  "title",
  "branch",
  "branch-name",
  "location",
  "base",
  "target",
]);

/** The flags that are switches. Kept beside the value flags so an unknown flag can be refused
 * rather than silently accepted, and so the surface can grow without a typo becoming a switch. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "help", "force", "any", "all"]);

export const isKnownFlag = (name: string): boolean =>
  VALUE_FLAGS.has(name) || BOOLEAN_FLAGS.has(name);

export const parseArgs = (
  argv: readonly string[],
  valueFlags: ReadonlySet<string> = VALUE_FLAGS,
): ParsedArgs => {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals !== -1) {
        flags.set(arg.slice(2, equals), arg.slice(equals + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (valueFlags.has(name) && next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        index++;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
};

export const stringFlag = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

export const boolFlag = (args: ParsedArgs, name: string): boolean =>
  args.flags.get(name) === true || args.flags.get(name) === "true";
