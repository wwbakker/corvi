import { type JSX, useCallback, useEffect, useState } from "react";
import { apiClient } from "../../app-root/api.ts";
import { DEFAULT_REMOTE_ACCESS_PORT } from "@corvi/contracts/config";
import type { RemoteAccessStatusDto } from "@corvi/contracts/api";
import type { TailscaleStatusDto } from "@corvi/contracts/tailscale";
import { CheckField, Field } from "./SettingsFields.tsx";

/**
 * Remote access: whether the external (authenticated) listener runs, on which port, and whether
 * `tailscale serve` publishes it to the tailnet.
 *
 * The toggle and the port are settings — they ride the draft and are written by the page's Save,
 * which brings the listener up or down without a restart. Publishing is an immediate action, not
 * a setting: it runs a command and answers now. The two are shown together because publishing
 * only makes sense once the listener is bound, and the section says so when it is not.
 */
export function RemoteAccessSection({
  enabled,
  port,
  bindStatus,
  onEnabledChange,
  onPortChange,
}: {
  enabled: boolean;
  port: number;
  /** Whether the external listener the settings asked for is actually bound. */
  bindStatus: RemoteAccessStatusDto;
  onEnabledChange: (enabled: boolean) => void;
  onPortChange: (port: number) => void;
}): JSX.Element {
  const [portText, setPortText] = useState(String(port));
  const [tailscale, setTailscale] = useState<TailscaleStatusDto>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // The draft is the source of truth for the port; the text field is only its editor, so an
  // invalid value never reaches the draft and the port the user last typed correctly stands.
  useEffect(() => setPortText(String(port)), [port]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTailscale(await apiClient.tailscale.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Refetch when the bind status changes: a save that moved the listener (or its port) must not
  // leave a published URL on screen that disagrees with where the listener actually is.
  useEffect(() => {
    void refresh();
  }, [refresh, bindStatus]);

  const run = async (action: () => Promise<TailscaleStatusDto>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setTailscale(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setPort = (text: string): void => {
    setPortText(text);
    const parsed = Number(text);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) onPortChange(parsed);
  };

  const published = tailscale?.publishedUrl;
  const blocked = tailscale?.blocked;
  // Publishing is refused while a blocked state holds (a shared or foreign 443): the button is
  // disabled and the reason is shown below, with the manual escape for the shared case.
  const cannotPublish =
    !bindStatus.listening || busy || tailscale === undefined || blocked !== undefined;

  return (
    <div className="form">
      <CheckField
        label="Enable remote access"
        hint="A second loopback listener, authenticated with paired device tokens. Off means nothing is reachable from the tailnet, whatever Tailscale is serving."
        checked={enabled}
        onChange={onEnabledChange}
      />
      <Field
        label="Port"
        hint="The loopback port the external listener binds. Tailscale publishes this port, never a network interface. Changing it restarts the listener when the settings are saved."
        value={portText}
        placeholder={String(DEFAULT_REMOTE_ACCESS_PORT)}
        onChange={setPort}
      />
      {enabled && !bindStatus.listening && (
        <p className="error-banner">{bindStatus.error ?? "the external listener is not bound"}</p>
      )}

      <div className="remote-publish">
        <span className="label">Tailscale</span>
        {tailscale === undefined ? (
          <small>checking…</small>
        ) : !tailscale.available ? (
          <small>Tailscale is not installed on this machine.</small>
        ) : !tailscale.running ? (
          <small>Tailscale is not connected.</small>
        ) : published ? (
          <div className="row">
            <a href={published} target="_blank" rel="noreferrer">
              {published}
            </a>
            <button
              type="button"
              className="choose"
              disabled={busy}
              onClick={() => void run(() => apiClient.tailscale.unpublish())}
            >
              Stop publishing
            </button>
          </div>
        ) : (
          <div className="row">
            <button
              type="button"
              className="create"
              disabled={cannotPublish}
              onClick={() => void run(() => apiClient.tailscale.publish())}
            >
              {busy ? "Publishing…" : "Publish to Tailscale"}
            </button>
            {!bindStatus.listening && <small>Save with remote access enabled first.</small>}
          </div>
        )}
        {tailscale?.error && (
          <p className={blocked ? "error-banner" : "hint"}>{tailscale.error}</p>
        )}
        {blocked === "mixed" && (
          <p className="hint">
            Corvi will not remove a 443 tree it shares with another handler. Unpublish by hand with{" "}
            <code>tailscale serve --https=443 off</code>, then publish again.
          </p>
        )}
        {error && <p className="error-banner">{error}</p>}
      </div>
    </div>
  );
}
