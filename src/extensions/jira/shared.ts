/**
 * The jira extension's vocabulary, shared between its two halves: the server reads and writes
 * these, the browser renders them. Types only, so the client half can import this file without
 * importing anything that runs on the server.
 */

/** An issue as IWE reads it, flattened from Jira's own shape. */
export type Issue = {
  key: string;
  summary: string;
  assignee: string;
  status: string;
  type: string;
  /** Sprint name, or "" for issues in no sprint (backlog). */
  sprint: string;
};

export type Sprint = { id: string; name: string; state: string };

/** What the wizard's issue table is served: the board, or why there is no board — an error
 * string rather than a failure, because a broken or unconfigured Jira must still leave you able
 * to type a change id by hand. */
export type Board = { issues: Issue[]; sprints: string[]; baseUrl?: string; error?: string };

/** What the jira extension writes into a change's `extensions` bag when its wizard step picked
 * an issue. */
export type TicketRef = { key: string };
