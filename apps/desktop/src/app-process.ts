/**
 * The app's own process, told apart from everything it starts.
 *
 * The app's server and its terminal host run on the same executable — the bundle's binary with
 * `ELECTRON_RUN_AS_NODE=1`, a script path as the first argument — and the host deliberately
 * outlives the app (docs/manual/install.md). A command line that names the binary and nothing but
 * flags is the app itself; anything with a script argument is a child, and quitting the window
 * must not take the user's terminals with it.
 */
export const isAppProcess = (command: string, executable: string): boolean => {
  const line = command.trim();
  if (line === executable) return true;
  if (!line.startsWith(`${executable} `)) return false;
  // LaunchServices passes flags of its own when the app is opened from Finder (`-psn_0_…`).
  return line
    .slice(executable.length)
    .trim()
    .split(/\s+/)
    .every((argument) => argument.startsWith("-"));
};
