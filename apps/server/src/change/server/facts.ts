/** The change's own values, as text that renders them needs them.
 *
 * A structural type of its own, not `@corvi/actions/render`'s `ActionFacts`: the change module
 * must not depend on the actions package, and the two shapes match without one importing the
 * other. `factsFor` keeps the exact values the actions runner used (`changeDir`/`PLAN_FILE` for
 * the plan path, each checkout's basename for the repository names). */
import { basename, join } from "node:path";

import { PLAN_FILE, type Change } from "@corvi/changes/record";
import { changeDir } from "./store.ts";

export type ChangeFacts = {
  readonly id: string;
  readonly title?: string;
  readonly branch?: string;
  /** The path of the plan file, as the app resolved it. */
  readonly plan: string;
  readonly state?: string;
  /** The change's directory. */
  readonly dir?: string;
  /** The names of the change's checkouts. */
  readonly repos?: readonly string[];
};

export const factsFor = (change: Change): ChangeFacts => ({
  id: change.id,
  title: change.title,
  branch: change.branch,
  plan: join(changeDir(change), PLAN_FILE),
  state: change.state,
  dir: changeDir(change),
  repos: (change.checkouts ?? []).map((spec) => basename(spec.path)),
});
