/**
 * The key that opens a new terminal window, shared by the page (TerminalPane) and by the script
 * injected into ttyd's page (terminal/server/proxy.ts), which forwards the key as a message
 * because a frame cannot open a window itself.
 *
 * macOS opens windows with cmd. On Linux meta is Super, which the window manager and the browser
 * both have claims on, so ctrl-alt-t is the binding there — meta-t still works, it is just not
 * the one hinted at. tmux's own ctrl-b c is a shell key and untouched by any of this.
 *
 * The helper is deliberately self-contained — no imports, no closure — because it reaches the
 * shim as source: the page bundle imports it as code, and terminal/server/proxy.ts stringifies
 * it into /terminal-keys.js with the platform baked in. Living in the module's model.ts keeps
 * that pure vocabulary out of both halves, so the server can embed it without importing a
 * client file.
 */

/** Which desktop the server runs on, as one word. "other" gets the macOS bindings: it is an
 * unsupported platform, and macOS is the UI's fallback. */
export type Platform = "mac" | "linux" | "other";

/** The part of KeyboardEvent the test reads, so the injected script can pass a plain object. */
type Keyish = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

export const isNewWindowKey = (e: Keyish, platform: Platform): boolean => {
  // macOS: cmd-t, with ctrl and alt excluded so tmux's ctrl-b chords stay tmux's.
  const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
  // ctrl-alt rather than meta on Linux: Super is the window manager's, and a keydown that
  // reaches the page with it held is a coin toss.
  const linux = e.ctrlKey && e.altKey && !e.metaKey;
  return e.key === "t" && (cmd || (platform === "linux" && linux));
};
