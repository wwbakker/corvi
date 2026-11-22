/** The harness a new subagent starts when its profile names none, picked from the change's
 * discovered harnesses. "Default" stores nothing and shows what the settings chain resolves to. */
import { type JSX, useEffect, useState } from "react";
import type { ChangeId } from "@corvi/contracts/changes";
import type { HarnessListResponseDto } from "@corvi/contracts/harnesses";

import type { CorviClient } from "@corvi/client";

export function SubagentHarnessSelect({
  changeId,
  client,
  value,
  onChange,
  disabled,
}: {
  changeId: ChangeId;
  client: CorviClient;
  /** The stored key, or undefined for "Default". */
  value?: string;
  onChange: (key: string | null) => void;
  disabled?: boolean;
}): JSX.Element {
  const [listed, setListed] = useState<HarnessListResponseDto | null>(null);
  useEffect(() => {
    client.harnesses
      .summaries(changeId)
      .then(setListed)
      .catch(() => setListed(null));
  }, [changeId, client]);
  const fallback = listed?.selection.subagentDefault ?? "builtin:pi";
  return (
    <label className="harness-select">
      <span>Subagent harness</span>
      <select
        aria-label="subagent harness"
        disabled={disabled === true || listed === null}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">Default ({fallback})</option>
        {(listed?.harnesses ?? []).map((harness) => (
          <option key={harness.key} value={harness.key}>
            {harness.label} ({harness.key})
          </option>
        ))}
      </select>
    </label>
  );
}
