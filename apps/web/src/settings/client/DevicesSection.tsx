import { type JSX, useCallback, useEffect, useState } from "react";
import { apiClient } from "../../app-root/api.ts";
import { moment } from "../../app-root/moment.ts";
import type { DeviceViewDto, PairingCodeResponseDto } from "@corvi/contracts/devices";

/**
 * The host's device management: mint a short-lived pairing code for the remote machine, see the
 * devices that have paired, and revoke one. A code is shown once and is single-use; the device
 * list carries each device's identity and lifecycle, never a token.
 *
 * Everything here is an immediate action rather than a setting: a code is minted now, a device is
 * revoked now. Nothing rides the settings draft.
 */
export function DevicesSection(): JSX.Element {
  const [devices, setDevices] = useState<DeviceViewDto[]>();
  const [code, setCode] = useState<PairingCodeResponseDto>();
  const [codeCleared, setCodeCleared] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDevices(await apiClient.devices.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tick while a code is on screen so its remaining life counts down; stop once it is gone or
  // elapsed.
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setCode(await apiClient.devices.createPairingCode());
      setCodeCleared(false);
      setCopied(false);
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await apiClient.devices.revoke(id);
      // Revoking ends the trust every outstanding code represents, so the code on display is no
      // longer redeemable: clear it rather than let it count down to a confusing refusal.
      if (code) {
        setCode(undefined);
        setCodeCleared(true);
        setCopied(false);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
    } catch {
      setError("could not copy the code");
    }
  };

  const remaining = code ? Math.max(0, new Date(code.expiresAt).getTime() - now) : 0;
  const seconds = Math.floor(remaining / 1000);
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="form wide">
      <div className="field">
        <span className="label">Pairing code</span>
        {code && remaining > 0 ? (
          <div className="row">
            <code className="pairing-code">{code.code}</code>
            <button type="button" className="choose" onClick={() => void copy()} disabled={busy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <small>Expires in {countdown}</small>
          </div>
        ) : (
          <div className="row">
            <button type="button" className="create" onClick={() => void create()} disabled={busy}>
              {busy ? "Creating…" : "Create a pairing code"}
            </button>
            <small>
              On the remote device, open the Corvi URL and enter the code on its pairing screen.
            </small>
          </div>
        )}
        {code && remaining === 0 && <small>That code has expired. Create another.</small>}
        {codeCleared && (
          <small>Revoking a device invalidates outstanding pairing codes. Create another.</small>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="field">
        <span className="label">Paired devices</span>
        {devices === undefined ? (
          <small>loading…</small>
        ) : devices.length === 0 ? (
          <small>No devices have paired yet.</small>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Paired</th>
                <th>Last seen</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>{moment(device.createdAt)}</td>
                  <td>{device.lastSeenAt ? moment(device.lastSeenAt) : "never"}</td>
                  <td>{device.revokedAt ? `revoked ${moment(device.revokedAt)}` : "active"}</td>
                  <td>
                    {!device.revokedAt && (
                      <button
                        type="button"
                        className="remove"
                        disabled={busy}
                        onClick={() => void revoke(device.id)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
