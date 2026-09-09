import type { Change } from "../../types.ts";

/**
 * The github-issues extension's vocabulary, shared between its two halves. Types only, so the
 * client half can import this file without importing anything that runs on the server.
 */

/** An issue as IWE reads it, flattened from what `gh` answers. */
export type GitHubIssue = {
  number: number;
  title: string;
  /** GitHub's own: "open" or "closed". */
  state: string;
  url?: string;
  assignees: string[];
  labels: string[];
};

/** What the extension writes into a change's `extensions` bag: which repository, which issue.
 * The repository is the source path, so a renamed GitHub repository still resolves. */
export type IssueRef = { repo: string; number: number };

/** The bag key, which is also the extension's name. */
export const KEY = "github-issues";

/** The change's issue, from wherever this extension put it. */
export const refOf = (change: Change): IssueRef | undefined =>
  change.extensions?.[KEY] as IssueRef | undefined;

/** How the issue is spoken about: `owner/name#123`. */
export const refLabel = (nameWithOwner: string, ref: IssueRef): string =>
  `${nameWithOwner}#${ref.number}`;
