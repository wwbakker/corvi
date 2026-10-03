/**
 * The exit contract, and the one error a command raises to choose a code.
 *
 * Machine callers read the code before the text: a refusal (`4`) is retryable with different
 * arguments or `--force`, an unreachable server (`3`) is not, and a usage error (`2`) is the
 * caller's bug. The values are stated in the manual (`install.md`) and are part of the CLI's
 * contract, not an implementation detail.
 */
export const EXIT = {
  ok: 0,
  /** Anything unexpected: a bug, or a server that misbehaved. */
  failure: 1,
  /** The command line itself was wrong. */
  usage: 2,
  /** No server answered, or none owned the named change. */
  noServer: 3,
  /** The server refused the request: unknown change/action/subagent, or a refused transition. */
  refused: 4,
  /** An await ended because the window was lost or a turn was interrupted. */
  lost: 5,
  /** An await reached its horizon with nothing to report: check in on the subagents, then await
   * again. */
  timeout: 6,
} as const;

/** A failure with a chosen exit code. Everything the CLI prints to stderr comes from one of
 * these; the top level maps it to the code and never invents another. */
export class CliFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.failure) {
    super(message);
    this.name = "CliFailure";
    this.exitCode = exitCode;
  }
}
