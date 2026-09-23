import { expect, test } from "bun:test";

import type { TmuxWindow } from "@corvi/contracts/terminal";
import {
  COMMAND_ACTION_OPTION,
  COMMAND_EXIT_OPTION,
  COMMAND_NOTIFY_OPTION,
} from "@corvi/terminals/model";
import { commandWindowPresenter } from "@corvi/terminals/presenter";

/** A window as tmux reports it, with the wrapper's pane options in the active pane. */
const window = (options: Record<string, string>): TmuxWindow => ({
  index: 1,
  id: "@9",
  name: "wrap",
  command: "sh",
  active: true,
  activity: false,
  directory: "demo",
  named: false,
  options,
});

test("a window Corvi did not set up is not this presenter's", () => {
  expect(commandWindowPresenter.present(window({}))).toBeUndefined();
});

test("a running command is busy and says nothing yet", () => {
  const said = commandWindowPresenter.present(window({ [COMMAND_ACTION_OPTION]: "Run the tests" }));
  expect(said).toMatchObject({ label: "Run the tests", busy: true, state: "ok", attention: false });
  expect(said?.note).toBeUndefined();
});

test("a notified run wants you when it ends, and says how it ended", () => {
  const said = commandWindowPresenter.present(
    window({
      [COMMAND_ACTION_OPTION]: "Run the tests",
      [COMMAND_EXIT_OPTION]: "3",
      [COMMAND_NOTIFY_OPTION]: "1",
    }),
  );
  expect(said).toEqual({
    label: "Run the tests",
    running: "finished",
    state: "idle",
    busy: false,
    attention: true,
    note: "finished with exit code 3",
  });
});

test("keeping a window is not calling you", () => {
  const said = commandWindowPresenter.present(
    window({ [COMMAND_ACTION_OPTION]: "Peek", [COMMAND_EXIT_OPTION]: "0" }),
  );
  expect(said?.attention).toBe(false);
  expect(said?.note).toBe("finished with exit code 0");
});

test("a half-written exit code reads as still running", () => {
  const said = commandWindowPresenter.present(
    window({ [COMMAND_ACTION_OPTION]: "Peek", [COMMAND_EXIT_OPTION]: "3x" }),
  );
  expect(said?.busy).toBe(true);
  expect(said?.attention).toBe(false);
});
