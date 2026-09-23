import { CHANGE_STATES, IDEATION, isIdeation, type Change, type ChangeState } from "../domain/change.ts";
import { makeChangesClient } from "@corvi/client";
import type {
  Completion,
  CompletionProgress,
  CompletionReason,
  CompletionRefusal,
  CompletionStep,
  ProvisionResult,
} from "../domain/change.ts";
import type { Widget, WidgetItem } from "../domain/widget.ts";
import type { Entry } from "../workspace/model.ts";

export type {
  Change,
  ChangeState,
  Completion,
  CompletionProgress,
  CompletionReason,
  CompletionRefusal,
  CompletionStep,
  ProvisionResult,
  Widget,
  WidgetItem,
  Entry,
};
export { CHANGE_STATES, IDEATION, isIdeation };
export type Listing = { path: string; entries: Entry[] };
export type CardInfo = {
  name: string;
  title: string;
  perRepo: boolean;
  column: "left" | "right";
  /** The card's client half ships an editor; the page draws the pencil for it. */
  editable?: boolean;
};
export type RepoItems = { items: WidgetItem[] };
export type RepoState = {
  path: string;
  name: string;
  location: "new" | "original";
  branch: { kind: "change" } | { kind: "current" } | { kind: "existing"; name: string };
  base?: string;
  target?: string;
  unsafe?: { kind: string; text: string };
};

/** A repository chosen for a change: where its checkout lives, which branch it uses, and what
 * that branch starts from and merges into. */
export type Selection = {
  path: string;
  location: "new" | "original";
  branch: { kind: "change" } | { kind: "current" } | { kind: "existing"; name: string };
  base?: string;
  target?: string;
};

export type Branches = { branches: string[]; default?: string };

export type Created = { change: Change; provision: ProvisionResult[] };

/** A completed change and the notes from its own completion steps. */
export type Completed = { change: Change; notes: string[] };

/** A cancelled change and what cancelling deliberately left behind. */
export type Cancelled = { change: Change; loose: string[] };

/** A request cancelled because its card went away is not an error worth showing. */
export const aborted = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";

/** One typed client for the page, relative to the origin that served it: the read operations the
 * change page and the overview use. */
export const apiClient = makeChangesClient({ baseUrl: "" });
