import { expect, test } from "bun:test";

import { launchCommand, launchOf, shellQuote } from "../src/harness.ts";

test("pi is launched with the session id, name, model and thinking level", () => {
  const launch = launchOf({
    harness: "pi",
    sessionId: "reviewer-123",
    label: "Reviewer",
    model: "zai/glm-5.3-flash",
    effort: "high",
  });
  expect(launch).toEqual({
    command: "pi",
    args: ["--session-id", "reviewer-123", "--name", "Reviewer", "--model", "zai/glm-5.3-flash", "--thinking", "high"],
  });
  expect(launchCommand(launch)).toBe(
    "'pi' '--session-id' 'reviewer-123' '--name' 'Reviewer' '--model' 'zai/glm-5.3-flash' '--thinking' 'high'",
  );
});

test("pi omits the model and effort when the profile does not set them", () => {
  const launch = launchOf({ harness: "pi", sessionId: "s", label: "L" });
  expect(launch.args).toEqual(["--session-id", "s", "--name", "L"]);
});

test("opencode is launched with --session and --model, and no thinking flag", () => {
  const launch = launchOf({ harness: "opencode", sessionId: "s", label: "L", model: "zai/glm-5.3-flash", effort: "high" });
  expect(launch).toEqual({ command: "opencode", args: ["--session", "s", "--model", "zai/glm-5.3-flash"] });
});

test("a label or model with a quote is data to the shell, not syntax", () => {
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  const command = launchCommand(launchOf({ harness: "pi", sessionId: "s", label: "it's" }));
  expect(command).toContain("'it'\\''s'");
});
