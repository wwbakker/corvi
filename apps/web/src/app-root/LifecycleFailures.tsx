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
  // One banner per integration, as this card promises: a run can stop several repositories, and
  // they are one story ("git"), not one banner each.
  const byIntegration = new Map<string, string[]>();
  for (const result of failed) {
    const lines = byIntegration.get(result.integration) ?? [];
    lines.push(result.error ?? "failed");
    byIntegration.set(result.integration, lines);
  }
  return (
    <>
      {[...byIntegration].map(([integration, errors]) => (
        <div key={integration} className="error-banner">
          {integration}: {errors.join(" · ")}
        </div>
      ))}
    </>
  );
}
