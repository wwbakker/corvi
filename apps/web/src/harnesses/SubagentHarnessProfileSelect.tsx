/** The harness a new subagent starts when its profile names none, picked from the change's
 * discovered harnesses. "Default" stores nothing and shows what the settings chain resolves to. */
import { type JSX, useEffect, useState } from "react";
import type { ChangeId } from "@corvi/contracts/changes";
import type { HarnessProfileListResponseDto } from "@corvi/contracts/harness-profiles";

import type { CorviClient } from "@corvi/client";

export function SubagentHarnessProfileSelect({
  changeId,
  client,
  value,
  onChange,
  disabled,
  label = "Subagent harness profile",
}: {
  changeId: ChangeId;
  client: CorviClient;
  /** The stored key, or undefined for "Default". */
  value?: string;
  onChange: (key: string | null) => void;
  disabled?: boolean;
  /** The field name shown by the dialog. */
  label?: string;
}): JSX.Element {
  const [listed, setListed] = useState<HarnessProfileListResponseDto | null>(null);
  useEffect(() => {
    client.harnessProfiles
      .summaries(changeId)
      .then(setListed)
      .catch(() => setListed(null));
  }, [changeId, client]);
  const fallback = listed?.selection.subagentDefault ?? "builtin:pi";
  return (
    <label className="harness-select">
      <span>{label}</span>
      <select
        aria-label="subagent harness"
        disabled={disabled === true || listed === null}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">Default ({fallback})</option>
        {(listed?.harnessProfiles ?? []).map((harness) => (
          <option key={harness.key} value={harness.key}>
            {harness.label} ({harness.key})
          </option>
        ))}
      </select>
    </label>
  );
}
