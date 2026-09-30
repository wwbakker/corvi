/** Delivering an action: choosing the window and doing what the file said there.
 *
 * A prompt is pasted — a bracketed paste, so a multi-line text lands in the agent's editor whole
 * — and gets Enter only when the action submits it. A command is either pasted into a shell and
 * submitted (there, the keystroke is the user's to keep is *reading* it: no completion signal is
 * promised) or run in a new window of its own.
 *
 * Window choice (the agreed rule): the window you are on when it is of the action's kind,
 * otherwise the leftmost window of the right kind; `agent` with none running starts one. Which
 * windows are agent windows is the caller's knowledge — the app's presenters read pi's own
 * `@agent_status` — so candidates arrive already sorted by window index and tagged. */
import { Effect } from "effect";

import type { Action } from "./model.ts";
import type { CommandFailure, NewWindowOptions } from "@corvi/terminals/model";

export type WindowKind = "agent" | "plain";

export type CandidateWindow = {
  /** The window's id: stable across the reordering the tabs do. */
  readonly window: string;
  readonly label: string;
  readonly kind: WindowKind;
  readonly active: boolean;
};

export type DeliverRequest = {
  readonly changeId: string;
  /** Where a started window begins when the active pane has nowhere to ask. */
  readonly changeDir: string;
  readonly action: Action;
  /** The rendered body: the prompt to paste, or the command to run. */
  readonly text: string;
  /** The change's windows, in index order — the order the selection rule walks. */
  readonly candidates: readonly CandidateWindow[];
  /** The window the menu was opened on; `target: active` names this one. */
  readonly explicitWindow?: string;
};

export type Delivery = {
  /** Whether Enter followed: a submitted prompt, or a command. */
  readonly submitted: boolean;
  /** A window was started for this run. */
  readonly started: boolean;
  readonly window?: {
    readonly id: string;
    readonly label?: string;
  };
};

/** A delivery that has nowhere to go: `target: active` with no window, or `agent` asked for
 * with no `start` to fall back on. */
export type NoWindowForAction = {
  readonly _tag: "NoWindowForAction";
};

export type DeliveryFailure = CommandFailure | NoWindowForAction;

/** The terminal operations action delivery needs: start a window and write to one. The host
 * implements it for every window now; delivery does not care how, only that a window can be
 * started and written to. */
export type ActionSessions = {
  readonly newWindowRunning: (
    changeId: string,
    dir: string,
    command: string,
    options: NewWindowOptions,
  ) => Effect.Effect<string, CommandFailure>;
  readonly pastePromptTo: (window: string, text: string) => Effect.Effect<void, CommandFailure>;
  readonly submit: (window: string) => Effect.Effect<void, CommandFailure>;
};

/** The window a delivery wants: the one you are on when it is of the right kind, else the
 * leftmost of the right kind. `here` is the pane you are on, whatever kind it is. Pure. */
export const selectTargetWindow = (
  candidates: readonly CandidateWindow[],
  want: WindowKind | "here",
  explicit?: string,
): CandidateWindow | undefined => {
  const named = explicit === undefined ? undefined : candidates.find((c) => c.window === explicit);
  const here = named ?? candidates.find((c) => c.active);
  if (want === "here") return here;
  if (here?.kind === want) return here;
  return candidates.find((c) => c.kind === want);
};

/** Run one action over the terminal operations. The session exists before this is called (the
 * route ensures it, as the brief always did), so there is always a pane to ask. */
export const deliverAction = (
  sessions: ActionSessions,
  request: DeliverRequest,
): Effect.Effect<Delivery, DeliveryFailure> =>
  Effect.gen(function* () {
    const { action, text, changeId, changeDir, candidates } = request;

    if (action.kind === "prompt") {
      if (action.target === "new") {
        const started = yield* sessions.newWindowRunning(changeId, changeDir, action.start ?? "pi", {
          keepOpen: false,
        });
        yield* sessions.pastePromptTo(started, text);
        if (action.submit) yield* sessions.submit(started);
        return { submitted: action.submit, started: true, window: { id: started } };
      }
      const want = action.target === "agent" ? "agent" : "here";
      const target = selectTargetWindow(candidates, want, request.explicitWindow);
      if (target) {
        yield* sessions.pastePromptTo(target.window, text);
        if (action.submit) yield* sessions.submit(target.window);
        return {
          submitted: action.submit,
          started: false,
          window: { id: target.window, label: target.label },
        };
      }
      if (action.target !== "agent") {
        return yield* Effect.fail<NoWindowForAction>({ _tag: "NoWindowForAction" });
      }
      // An agent was asked for and none is running: start one, and paste into it.
      const started = yield* sessions.newWindowRunning(changeId, changeDir, action.start ?? "pi", {
        keepOpen: false,
      });
      yield* sessions.pastePromptTo(started, text);
      if (action.submit) yield* sessions.submit(started);
      return { submitted: action.submit, started: true, window: { id: started } };
    }

    // A command: in a window of its own, or pasted into the shell you are on and submitted.
    if (action.target === "new") {
      // notify implies keeping the window: a notification you cannot look behind is half a
      // feature.
      const keepOpen = action.keepOpen || action.notify;
      const options: NewWindowOptions = {
        keepOpen,
        ...(keepOpen ? { announce: { label: action.label, notify: action.notify } } : {}),
      };
      const started = yield* sessions.newWindowRunning(changeId, changeDir, text, options);
      return { submitted: true, started: true, window: { id: started } };
    }
    const target = selectTargetWindow(candidates, "here", request.explicitWindow);
    if (!target) return yield* Effect.fail<NoWindowForAction>({ _tag: "NoWindowForAction" });
    yield* sessions.pastePromptTo(target.window, text);
    yield* sessions.submit(target.window);
    return {
      submitted: true,
      started: false,
      window: { id: target.window, label: target.label },
    };
  });
