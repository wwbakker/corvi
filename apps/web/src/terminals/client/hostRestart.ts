import { useCallback, useEffect, useState } from "react";

import type { HostMismatchDto, HostStatusDto } from "@corvi/contracts/api";

import { apiClient } from "../../app-root/api.ts";
import { useServerEvent } from "../../app-root/events.ts";

/**
 * The terminal host this server is not running, and the restart it offers.
 *
 * The server keeps the host and reports the difference, because replacing it ends every shell,
 * agent and action run inside it. So finding out is cheap and passive — the status route reads the
 * owner record — and the one destructive action waits here until somebody clicks.
 *
 * Read on mount, whenever the server says the windows changed, and every half minute: a foreign
 * host appears when another instance writes the owner record, which this server cannot observe.
 */
const POLL_MS = 30_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type HostRestartView = {
  /** What the server says about the host; null until the first read lands. */
  readonly status: HostStatusDto | null;
  /** The host is not the one this server would have started. */
  readonly stale: boolean;
  /** The dialog is open. */
  readonly dialog: boolean;
  /** The restart is running: no second answer. */
  readonly busy: boolean;
  /** The last restart's own failure, when it never reached the host. */
  readonly error: string | null;
  readonly open: () => void;
  readonly close: () => void;
  readonly restart: () => void;
};

export function useHostRestart(): HostRestartView {
  const [status, setStatus] = useState<HostStatusDto | null>(null);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    apiClient.terminals
      .hostStatus()
      .then(setStatus)
      .catch(() => {}); // a status that cannot be read is no status; the next read retries
  }, []);
  useEffect(load, [load]);
  useServerEvent(
    "windows",
    useCallback(() => load(), [load]),
  );

  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const stale = (status?.stale.length ?? 0) > 0;

  // A difference that clears itself — the free replacement, or the other app's host gone — closes
  // the question with it: there is nothing left to answer.
  useEffect(() => {
    if (stale) return;
    setDialog(false);
    setError(null);
  }, [stale]);

  const restart = useCallback((): void => {
    setBusy(true);
    setError(null);
    apiClient.terminals
      .restartHost()
      .then((next) => {
        setStatus(next);
        setDialog(false);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  }, []);

  return {
    status,
    stale,
    dialog,
    busy,
    error,
    open: useCallback((): void => {
      setError(null);
      setDialog(true);
    }, []),
    close: useCallback((): void => setDialog(false), []),
    restart,
  };
}

/** One line for the icon's tooltip: what the running host is, in the words the user needs to
 * decide. Several differences are one sentence, because the tooltip is one line. */
export const hostMismatchTitle = (stale: readonly HostMismatchDto[]): string => {
  const said = new Set(stale.map((mismatch) => mismatch.kind));
  const parts: string[] = [];
  if (said.has("checkout")) parts.push("started from another checkout");
  if (said.has("build")) parts.push("running another build");
  if (said.has("protocol")) parts.push("speaking another protocol");
  return `Terminal host ${parts.join(" and ")} — restart it`;
};

/** The dialog's own sentence, with the values: a person deciding whether to end their shells needs
 * to see what differs, not only that something does. */
export const hostMismatchDetail = (mismatch: HostMismatchDto): string => {
  if (mismatch.kind === "checkout") {
    return `It was started from ${String(mismatch.theirs)}; this server runs from ${String(mismatch.ours)}.`;
  }
  if (mismatch.kind === "build") {
    return `It is running build ${String(mismatch.theirs)}; this server is build ${String(mismatch.ours)}.`;
  }
  return `It speaks host protocol ${String(mismatch.theirs)}; this server speaks ${String(mismatch.ours)}.`;
};

/** What the restart would end, for the dialog's warning. */
export const hostSessionsSentence = (sessions: HostStatusDto["sessions"]): string => {
  if (sessions === undefined) return "";
  if (sessions.live === 0) return "Nothing is running inside it, so the restart costs no work.";
  const terminals = `${sessions.live} terminal${sessions.live === 1 ? "" : "s"} will be closed with it.`;
  if (sessions.working === 0) return terminals;
  const agents =
    sessions.working === 1
      ? ` ${sessions.working} of them is running an agent that reports working, and loses its turn.`
      : ` ${sessions.working} of them are running agents that report working, and lose their turns.`;
  return terminals + agents;
};
