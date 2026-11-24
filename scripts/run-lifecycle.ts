/**
 * How a walk ends: its cleanup runs once, and a signal runs it before exiting.
 *
 * The trap guarantees that an interrupted walk takes away everything it owns before the process
 * exits — the browser, the fixture, the temp dir and the lock — and exits with the signal's code
 * (130 for SIGINT, 143 for SIGTERM). `interrupt` stops the walk from starting another surface, so
 * nothing new is owned while the cleanup runs.
 */
const SIGNAL_EXIT_CODES: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
];

/** Run `cleanup` at most once, whatever asks for it: the normal exit, a failure, or a signal. A
 * cleanup failure must not replace the run's own exit code. */
export const cleanupOnce = (cleanup: () => Promise<void>): (() => Promise<void>) => {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= cleanup().catch((error: unknown) => {
      console.error(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }));
};

/** Install the SIGINT/SIGTERM trap. Both signals share the same one-shot cleanup. */
export const installSignalCleanup = (cleanup: () => Promise<void>, interrupt: () => void): void => {
  for (const [signal, code] of SIGNAL_EXIT_CODES) {
    process.on(signal, () => {
      interrupt();
      void cleanup().then(() => process.exit(code));
    });
  }
};
