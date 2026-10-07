import { type JSX, type ReactNode } from "react";
import { useSourceAvailability } from "./sources.ts";

/**
 * The unavailable-workspace banner for a viewed source: the server's fixed reason, an immediate
 * coordinated **Retry now**, and a way to local configuration. It is keyed to the source the page
 * is *showing*, not only to the chosen workspace, so a change opened by direct link — or a change
 * in another workspace under **All work** — says the same thing.
 */
export function RemoteAvailabilityBanner({
  source,
  name,
  onSettings,
}: {
  source: string;
  /** The workspace's name, for the sentence; a change's own title is not this. */
  name?: string;
  onSettings?: () => void;
}): JSX.Element | null {
  const { status, retry } = useSourceAvailability(source);
  if (status._tag !== "unavailable") return null;
  return (
    <div className="remote-unavailable" role="status" aria-live="polite">
      <span className="remote-unavailable-text">
        {name === undefined || name === "" ? "This workspace" : name} is unavailable:{" "}
        {status.reason.message}
      </span>
      <span className="spacer" />
      <button onClick={retry}>Retry now</button>
      {onSettings !== undefined && (
        <button onClick={onSettings} title="Open local configuration">
          Local settings
        </button>
      )}
    </div>
  );
}

/** A retained remote answer that is no longer live. The data stays visible and usable to read;
 * the marker is what keeps it from reading as current. */
export function StaleMarker({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <span className="stale-marker" title="the workspace is unavailable; this is the last known answer">
      {children ?? "stale"}
    </span>
  );
}
