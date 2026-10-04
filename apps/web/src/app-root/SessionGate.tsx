import { type JSX, type ReactNode, useEffect, useState } from "react";
import { ClientError } from "@corvi/client";
import { apiClient } from "./api.ts";
import { PairingScreen } from "../pairing/client/PairingScreen.tsx";

/**
 * The bootstrap check the app renders behind.
 *
 * The local listener answers `GET /api/devices/session` tokenless and the app renders exactly as
 * it always did — the check is a formality that changes nothing. On the external listener the
 * authorizer refuses an unauthenticated `/api/*` request with a typed 401, so an unpaired browser
 * is replaced by the pairing screen; a paired one carries the HttpOnly cookie and is left alone.
 * The screen reloads into the app once pairing sets that cookie.
 *
 * The app is rendered while the check is in flight, so the local listener never sees a loading
 * flash and the pages' first paint is unchanged. Only a 401 replaces it; any other failure is the
 * app's own to show, and the local origin is left exactly as it was.
 */
export function SessionGate({ children }: { children: ReactNode }): JSX.Element {
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient.devices.session().catch((failure: unknown) => {
      // Only a 401 means "this browser is not paired". A transient 5xx or a network blip is
      // left to the pages, which already handle their own errors.
      if (!cancelled && failure instanceof ClientError && failure.status === 401) setPairing(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (pairing) {
    return <PairingScreen onPaired={() => window.location.reload()} />;
  }
  return <>{children}</>;
}
