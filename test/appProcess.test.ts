import { describe, expect, test } from "bun:test";
import { isAppProcess } from "../apps/desktop/src/app-process.ts";

/**
 * What the installer may quit when it replaces the bundle. The app, its server and its terminal
 * host share one executable, so the command line is the only thing that tells them apart — and the
 * host must not be in the answer (docs/manual/install.md: host sessions survive an install).
 */
const app = "/Users/me/Applications/Corvi.app/Contents/MacOS/Corvi";

describe("the app's own process", () => {
  test("is the bundle executable, with flags and nothing else", () => {
    expect(isAppProcess(app, app)).toBe(true);
    // LaunchServices passes its own flag when the app is opened from Finder.
    expect(isAppProcess(`${app} -psn_0_123456`, app)).toBe(true);
    expect(isAppProcess(`  ${app}  `, app)).toBe(true);
  });

  test("is not the server or the terminal host it started", () => {
    // Both run on the app's own binary as node, with a script path first.
    expect(isAppProcess(`${app} apps/server/src/server.ts`, app)).toBe(false);
    expect(
      isAppProcess(
        `${app} /Users/me/corvi/apps/server/src/terminals/host/main.ts --socket /tmp/host.sock`,
        app,
      ),
    ).toBe(false);
  });

  test("is not a neighbouring program or a wrapper around it", () => {
    // A path that merely begins with the executable's name is another program.
    expect(isAppProcess(`${app}Helper`, app)).toBe(false);
    expect(isAppProcess(`/bin/zsh -ilc ${app}`, app)).toBe(false);
    expect(isAppProcess("", app)).toBe(false);
  });
});
