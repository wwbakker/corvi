/**
 * The workspace module's pure vocabulary: the shape a repository-browser row has, which both
 * the server's directory walk and the browser's RepoBrowser speak. Nothing here runs; the
 * server half (`./server/`) imports this, and the browser half reads it without touching a
 * server file.
 */

/** One directory in the repository browser: its path relative to the repos root, its display
 * name, and whether it is a git repository and so selectable for a change. */
export type Entry = {
  /** Path relative to the repos root, e.g. "personal/my-project". */
  path: string;
  name: string;
  /** A git repository, so it can be selected as part of a change. */
  isRepo: boolean;
};
