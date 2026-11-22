/** The change's own user-pane harness: "Default" stores nothing, so later default changes still
 * apply; the option text says what Default resolves to right now. */
import { type JSX, useEffect, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import type { CorviClient } from "@corvi/client";
import type { HarnessListResponseDto } from "@corvi/contracts/harnesses";

export function UserHarnessSelect({
  changeId,
  client,
  stored,
  disabled,
  onChanged,
  label = "Harness",
}: {
  changeId: string;
  client: CorviClient;
  stored?: string;
  disabled?: boolean;
  onChanged: () => void;
  /** The field name; the dialog says which kind of pane it applies to. */
  label?: string;
}): JSX.Element {
  const [listed, setListed] = useState<HarnessListResponseDto | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    client.harnesses
      .summaries(ChangeId.make(changeId))
      .then(setListed)
      .catch(() => setListed(null));
  }, [changeId, client]);
  const fallback = listed?.selection.userDefault ?? "builtin:pi";
  const choose = async (key: string): Promise<void> => {
    setSaving(true);
    try {
      await client.changes.rename(ChangeId.make(changeId), { userHarness: key === "" ? null : key });
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  return (
    <label className="change-harness" title="the harness a new shell pane starts with">
      <span>{label}</span>
      <select
        aria-label="change user harness"
        disabled={disabled === true || saving || listed === null}
        value={stored ?? ""}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="">Default ({fallback})</option>
        {(listed?.harnesses ?? []).map((harness) => (
          <option key={harness.key} value={harness.key} disabled={harness.problem !== undefined}>
            {harness.label}
            {harness.problem === undefined ? "" : ` — ${harness.problem}`}
          </option>
        ))}
      </select>
    </label>
  );
}
