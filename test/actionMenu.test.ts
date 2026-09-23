import { expect, test } from "bun:test";

import { applicableActions, noticeFor } from "../apps/web/src/actions/RunMenu.tsx";
import type { ActionSummaryDto } from "@corvi/contracts/actions";
import type { TerminalWindow } from "../apps/web/src/domain/terminal.ts";

const action = (over: Partial<ActionSummaryDto>): ActionSummaryDto => ({
  key: "global:x",
  label: "X",
  kind: "prompt",
  target: "active",
  source: "global",
  ...over,
});

const tab = (over: Partial<TerminalWindow>): TerminalWindow => ({
  index: 0,
  id: "@1",
  label: "shell",
  detail: "",
  attention: false,
  active: true,
  activity: false,
  ...over,
});

const promptActive = action({ key: "global:ask", label: "Ask", kind: "prompt", target: "active" });
const commandActive = action({ key: "global:run", label: "Run", kind: "command", target: "active" });
const anywhere = action({ key: "global:new", label: "New", kind: "command", target: "new" });

test("an active target is offered where its delivery makes sense", () => {
  const agent = tab({ icon: "agent" });
  const shell = tab({ icon: "terminal" });
  // A prompt goes to the agent you are looking at; a command goes to a plain shell.
  expect(applicableActions([promptActive, commandActive, anywhere], agent)).toEqual([promptActive, anywhere]);
  expect(applicableActions([promptActive, commandActive, anywhere], shell)).toEqual([commandActive, anywhere]);
  // With nothing on screen, only the targets that name their own window.
  expect(applicableActions([promptActive, commandActive, anywhere], undefined)).toEqual([anywhere]);
});

test("the notice names the window it went to and what happened there", () => {
  const window = { id: "@2", label: "orders-api (pi)" };
  expect(noticeFor("Ask", { kind: "prompt", submitted: false, started: false, window })).toBe(
    "Pasted into orders-api (pi) — read it and send it",
  );
  expect(noticeFor("Ask", { kind: "prompt", submitted: true, started: false, window })).toBe(
    "Sent to orders-api (pi)",
  );
  expect(noticeFor("Run", { kind: "command", submitted: true, started: false, window })).toBe(
    'Running "Run" in orders-api (pi)',
  );
  // A started window has no presented label yet; a label-less one falls back to its id.
  expect(noticeFor("New", { kind: "command", submitted: true, started: true })).toBe(
    'Running "New" in a new window',
  );
  expect(noticeFor("Ask", { kind: "prompt", submitted: false, started: true })).toBe(
    'Started a window and pasted "Ask"',
  );
  expect(noticeFor("Ask", { kind: "prompt", submitted: false, started: false, window: { id: "@7" } })).toBe(
    "Pasted into @7 — read it and send it",
  );
});
