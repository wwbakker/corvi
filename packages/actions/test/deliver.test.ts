import { expect, test } from "bun:test";
import { Effect } from "effect";

import type { Action } from "../src/model.ts";
import type { NewWindowOptions, Sessions } from "@corvi/terminals/tmux";
import {
  deliverAction,
  selectTargetWindow,
  type CandidateWindow,
  type DeliverRequest,
  type Delivery,
} from "../src/deliver.ts";

/** A Sessions that records what it was asked to do. Unscripted operations record themselves and
 * answer with an empty success, so a test only scripts what it cares about. */
const recording = (): {
  sessions: Sessions;
  calls: string[];
  started: { command: string; options: NewWindowOptions }[];
} => {
  const calls: string[] = [];
  const started: { command: string; options: NewWindowOptions }[] = [];
  const sessions: Sessions = {
    sessionName: (id) => `corvi-${id}`,
    terminalSocketPath: (id) => `/api/changes/${id}/terminal/socket`,
    attachCommand: () => ["tmux"],
    stopTerminal: () => Effect.void,
    windows: () => Effect.succeed([]),
    allWindows: () => Effect.succeed({}),
    changeOfSession: () => undefined,
    newWindow: () => Effect.void,
    newWindowRunning: (_id, _dir, command, options) => {
      started.push({ command, options });
      calls.push(`new:${command}`);
      return Effect.succeed(`@${started.length}`);
    },
    selectWindow: () => Effect.void,
    moveWindow: () => Effect.void,
    ensureSession: () => Effect.void,
    pastePromptTo: (window, text) => {
      calls.push(`paste:${window}:${text}`);
      return Effect.void;
    },
    submit: (window) => {
      calls.push(`submit:${window}`);
      return Effect.void;
    },
  };
  return { sessions, calls, started };
};

const prompt: Action = {
  label: "Review",
  kind: "prompt",
  target: "agent",
  start: "pi",
  submit: false,
  notify: false,
  keepOpen: false,
  body: "Look at it",
};

const command: Action = {
  label: "Run the tests",
  kind: "command",
  target: "new",
  submit: false,
  notify: true,
  keepOpen: false,
  body: "bun test",
};

const windows: readonly CandidateWindow[] = [
  { window: "@1", label: "shell", kind: "plain", active: false },
  { window: "@2", label: "pi working", kind: "agent", active: true },
  { window: "@3", label: "tests", kind: "plain", active: false },
];

const request = (overrides: Partial<DeliverRequest>): DeliverRequest => ({
  changeId: "PROJ-1",
  changeDir: "/changes/PROJ-1",
  action: prompt,
  text: "Look at it",
  candidates: windows,
  ...overrides,
});

test("the window rule: the one you are on when it fits, else the leftmost that does", () => {
  expect(selectTargetWindow(windows, "agent")?.window).toBe("@2"); // active and an agent
  expect(selectTargetWindow(windows, "agent", "@1")?.window).toBe("@2"); // on a shell: leftmost agent
  expect(selectTargetWindow(windows, "here", "@3")?.window).toBe("@3"); // the window the menu was on
  expect(selectTargetWindow(windows, "here")?.window).toBe("@2");
  expect(selectTargetWindow(windows.filter((w) => w.kind === "plain"), "agent")).toBeUndefined();
});

test("a prompt to the agent is pasted and left for reading; submit sends it", () => {
  const noSubmit = recording();
  const delivery = Effect.runSync(
    deliverAction(noSubmit.sessions, request({})).pipe(Effect.orElseSucceed(() => ({ submitted: false, started: false }))),
  );
  expect(delivery).toEqual({ submitted: false, started: false, window: { id: "@2", label: "pi working" } });
  expect(noSubmit.calls).toEqual(["paste:@2:Look at it"]);

  const submitted = recording();
  Effect.runSync(
    deliverAction(submitted.sessions, request({ action: { ...prompt, submit: true } })).pipe(
      Effect.orElseSucceed(() => ({ submitted: false, started: false })),
    ),
  );
  expect(submitted.calls).toEqual(["paste:@2:Look at it", "submit:@2"]);
});

test("an agent asked for with none running starts one and pastes into it", () => {
  const { sessions, calls, started } = recording();
  const delivery: Delivery = Effect.runSync(
    deliverAction(sessions, request({ candidates: [], action: { ...prompt, submit: true } })).pipe(
      Effect.orElseSucceed(() => ({ submitted: false, started: false })),
    ),
  );
  expect(delivery.started).toBe(true);
  expect(delivery.window?.id).toBe("@1");
  expect(started).toEqual([{ command: "pi", options: { keepOpen: false } }]);
  expect(calls).toEqual(["new:pi", "paste:@1:Look at it", "submit:@1"]);
});

test("a prompt into a new window uses its start, never a bare shell", () => {
  const { sessions, calls, started } = recording();
  Effect.runSync(
    deliverAction(sessions, request({ action: { ...prompt, target: "new", start: "pi" } })).pipe(
      Effect.orElseSucceed(() => ({ submitted: false, started: false })),
    ),
  );
  expect(started[0]?.command).toBe("pi");
  expect(calls).toEqual(["new:pi", "paste:@1:Look at it"]);
});

test("a command window runs the body; notify freezes it and announces the ending", () => {
  const plain = recording();
  Effect.runSync(
    deliverAction(
      plain.sessions,
      request({ action: { ...command, notify: false }, text: "bun test" }),
    ).pipe(Effect.orElseSucceed(() => ({ submitted: false, started: false }))),
  );
  expect(plain.started).toEqual([{ command: "bun test", options: { keepOpen: false } }]);

  const notified = recording();
  const delivery = Effect.runSync(
    deliverAction(notified.sessions, request({ action: command, text: "bun test" })).pipe(
      Effect.orElseSucceed(() => ({ submitted: false, started: false })),
    ),
  );
  expect(delivery).toEqual({ submitted: true, started: true, window: { id: "@1" } });
  // notify implies keeping the window: a notification you cannot look behind is half a feature.
  expect(notified.started[0]?.options).toEqual({
    keepOpen: true,
    announce: { label: "Run the tests", notify: true },
  });
});

test("a command in the shell you are on is pasted and submitted; nowhere is a refusal", () => {
  const here = recording();
  const delivery: Delivery = Effect.runSync(
    deliverAction(
      here.sessions,
      request({ action: { ...command, target: "active" }, explicitWindow: "@3", text: "bun test" }),
    ).pipe(Effect.orElseSucceed(() => ({ submitted: false, started: false }))),
  );
  expect(delivery.window).toEqual({ id: "@3", label: "tests" });
  expect(here.calls).toEqual(["paste:@3:bun test", "submit:@3"]);

  const none = recording();
  const failure = Effect.runSync(
    deliverAction(none.sessions, request({ action: { ...command, target: "active" }, candidates: [], text: "bun test" })).pipe(
      Effect.map(() => "ran"),
      Effect.catchAll((e) => Effect.succeed("_tag" in e ? "refused" : "other")),
    ),
  );
  expect(failure).toBe("refused");
});
