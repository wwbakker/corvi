import { type JSX, useState } from "react";
import type { RemoteWorkspaceDto } from "@corvi/contracts/config";
import type { RemoteWorkspaceRefDto } from "@corvi/contracts/api";
import { apiClient } from "../../app-root/api.ts";
import { Field, Group } from "./SettingsFields.tsx";

/**
 * The fields a remote workspace has: where its server is, which of that server's workspaces it
 * is, and the device token this client presents there. It has no settings fields — those live on
 * the server that hosts it.
 *
 * The token is a secret the page is never given: a stored one reads as the mask, and a save that
 * sends the mask back keeps what the file holds. "Pair" runs the server-side helper — the page
 * cannot reach the remote itself — redeems the code there, and fills the token; the remote's
 * workspaces come back with it, so the target is a picker rather than a guess.
 */
export function RemoteWorkspaceSection({
  remote,
  onChange,
}: {
  remote: RemoteWorkspaceDto;
  onChange: (next: RemoteWorkspaceDto) => void;
}): JSX.Element {
  const [code, setCode] = useState("");
  const [device, setDevice] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const [found, setFound] = useState<RemoteWorkspaceRefDto[]>();
  // The target the token in hand belongs to, captured at mount. If either half changes, the
  // stored token no longer applies to what will be saved (the server drops it — it must not
  // travel to a different server or workspace), and the editor says so before Save rather than
  // after. A backstop: the write path is what makes it safe.
  const [pairedTarget] = useState({ url: remote.url, workspace: remote.workspace });
  const targetChanged =
    (remote.url.trim() !== pairedTarget.url || remote.workspace !== pairedTarget.workspace) &&
    remote.token !== undefined &&
    remote.token !== "";

  const pair = (): void => {
    setPairing(true);
    setError(undefined);
    apiClient.workspaces
      .pairRemote({ url: remote.url, code, ...(device.trim() ? { name: device } : {}) })
      .then((paired) => {
        setFound(paired.workspaces);
        // The token goes into the draft, where Save will write it; the picker below then fills
        // the target from what the remote actually offers.
        onChange({ ...remote, token: paired.token });
        setCode("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setPairing(false));
  };

  return (
    <>
      <Field
        label="Remote address"
        hint="The other server's base URL, published by its Tailscale serve."
        value={remote.url}
        placeholder="https://machine.tailnet.ts.net"
        onChange={(url) => onChange({ ...remote, url })}
      />
      {targetChanged && (
        <div className="notice">
          The target changed, so the stored token no longer applies. Saving clears it; pair with
          that server to get a token for it.
        </div>
      )}
      <Field
        label="Remote workspace"
        hint="That server's own id for this workspace — not the id above."
        value={remote.workspace}
        placeholder="default"
        onChange={(workspace) => onChange({ ...remote, workspace })}
      />
      <Field
        label="Device token"
        hint="Kept in this machine's config file and masked here; a save that leaves the mask keeps it."
        value={remote.token}
        secret
        onChange={(token) => onChange({ ...remote, token })}
      />

      <Group label="Pair with that server">
        <Field
          label="Pairing code"
          hint="Mint one on the other server: Settings → Devices."
          value={code}
          onChange={setCode}
        />
        <Field
          label="This device's name"
          hint="What the other server will call this machine. Optional."
          value={device}
          onChange={setDevice}
        />
        <button
          type="button"
          className="primary"
          disabled={!remote.url.trim() || !code.trim() || pairing}
          onClick={pair}
        >
          {pairing ? "Pairing…" : "Pair"}
        </button>
      </Group>

      {error && <div className="error-banner">{error}</div>}

      {found && found.length > 0 && (
        <Group label="Workspaces on that server">
          <label>
            <span>Choose the workspace</span>
            <select
              value={remote.workspace}
              onChange={(e) => onChange({ ...remote, workspace: e.target.value })}
            >
              <option value="">choose…</option>
              {found.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name} ({one.id})
                </option>
              ))}
            </select>
          </label>
        </Group>
      )}
    </>
  );
}
