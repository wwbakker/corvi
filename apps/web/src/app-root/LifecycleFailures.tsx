import type { JSX } from "react";
import type { ProvisionResult } from "./api.ts";

/**
 * The failed provisioning results, as the page shows them: one error banner per integration,
 * attributed to it, and nothing at all for a step that succeeded. The create and start paths
 * collect the per-integration results rather than throwing them (the change already exists, and
 * a half-provisioned change is fixable once you can see what went wrong), so this is where that
 * wordless result becomes something you can read.
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
