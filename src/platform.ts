/**
 * The one place platform ifs live: everything else imports the answer instead of asking
 * `process.platform` itself, so a new platform means editing this file and the callers it
 * names, not grepping the tree for assumptions.
 */

/** macOS, where the native app and `open -a` live. */
export const isMac = process.platform === "darwin";

/** Linux. Anything else (Windows) is unsupported and gets neither platform's favours. */
export const isLinux = process.platform === "linux";

/** The loopback interface's name, which differs where it need not: macOS calls it lo0, Linux lo.
 * ttyd's `--interface` takes a name rather than an address, and binding the terminal to loopback
 * keeps a shell off the network. */
export const loopbackInterface = isMac ? "lo0" : "lo";

/** Whether a command could actually run: is it on PATH right now? Synchronous, because the only
 * things asking are building a menu and can wait a microsecond; a stale answer would offer an
 * item that cannot work, so it is always asked fresh. */
export const commandAvailable = (command: string): boolean => Bun.which(command) !== null;

/** The platform as one word, for whoever is told only once: the client reads it from
 * /api/workspaces and switches its key hints and shortcuts on it. */
export const platformName = isMac ? "mac" : isLinux ? "linux" : "other";
