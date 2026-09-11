import type { JSX } from "react";
import type { ProvisionResult } from "./api.ts";

/**
 * The failed results of a lifecycle hook, as the page shows them: one error banner per
 * extension, attributed to it, and nothing at all for a hook that succeeded — a successful
 * `change:created`, `change:completed` or `change:cancelled` observer changes nothing visible.
 *
 * The host collects observer failures rather than throwing them (the change already exists, and
 * a half-provisioned change is fixable once you can see what went wrong), so this is where that
 * wordless result becomes something you can read. `change:created` results arrive from the
 * wizard; `change:completed` and `change:cancelled` results arrive on the operation's response.
 */
export function LifecycleFailures({ results }: { results?: ProvisionResult[] }): JSX.Element | null {
  const failed = (results ?? []).filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return (
    <>
      {failed.map((r) => (
        <div key={r.integration} className="error-banner">
          {r.integration}: {r.error}
        </div>
      ))}
    </>
  );
}
