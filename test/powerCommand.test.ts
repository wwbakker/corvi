import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { platformName } from "../apps/server/src/capabilities/os.ts";
import { Power, PowerLive, powerCommand } from "../apps/server/src/capabilities/power.ts";
import { fakeShell, runWithShell } from "./helpers.ts";

test("linux powers off through systemctl", () => {
  expect(powerCommand("linux")).toEqual(["systemctl", "poweroff"]);
});

test("macOS shuts down through System Events", () => {
  expect(powerCommand("mac")).toEqual([
    "osascript",
    "-e",
    'tell application "System Events" to shut down',
  ]);
});

test("any other platform falls back to the macOS command", () => {
  expect(powerCommand("other")).toEqual(powerCommand("mac"));
});

test("a refused power command fails instead of reading as success", async () => {
  // `sh` treats a non-zero exit as a successful ShellResult, so the Power service itself must
  // turn it into a failure; otherwise a denied `systemctl` would look like the machine went off.
  const shell = fakeShell(() => ({ code: 1, stderr: "Interactive authentication required." }));
  const exit = await runWithShell(
    shell,
    Effect.gen(function* () {
      const power = yield* Power;
      return yield* Effect.exit(power.powerOff());
    }).pipe(Effect.provide(PowerLive)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  // The command ran: the failure is the exit code, not a skipped call.
  expect(shell.calls.map((call) => call.cmd)).toEqual([powerCommand(platformName)]);
});
