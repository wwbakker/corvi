import { useCallback, useEffect, useState } from "react";

import { apiClient } from "../app-root/api.ts";
import { useServerEvent } from "../app-root/events.ts";
import { hostOf } from "../app-root/host.ts";
import { getPref, setPref } from "../app-root/prefs.ts";
import type { AppUpdateStatus } from "./model.ts";

/**
 * The update feature's state: what is new, the dialog, the notice, and the three actions.
 *
 * One notice per remote head: the cookie remembers which tip was dismissed or seen in the
 * dialog, so clicking it away lasts — the server rediscovers the same version every two hours
 * and says "update" once per tip, and a reload must not nag about one already answered. The
 * status itself is read from the last check (local, free); a running update is polled fast, the
 * rest arrives on the `update` event or an action's own answer.
 */
const NOTICE_KEY = "corvi:update-notice";

export type AppUpdateView = {
  /** What the app knows about updating itself; null until the first read lands. */
  readonly status: AppUpdateStatus | null;
  /** The dialog is open. */
  readonly dialog: boolean;
  /** The "new version available" notice is on screen. */
  readonly notice: boolean;
  /** An update is running (just started, or the journal says so). */
  readonly busy: boolean;
  /** The last action's own failure — pre-check refusals never reach the journal. */
  readonly error: string | null;
  /** The manual check is running. */
  readonly checking: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly dismissNotice: () => void;
  readonly check: () => void;
  readonly start: () => void;
  /** Restart the app to finish an update. Absent in a real browser: there is no host to ask. */
  readonly restart: () => void;
  readonly canRestart: boolean;
};

export function useAppUpdate(): AppUpdateView {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notified, setNotified] = useState<string | null>(null);

  const load = useCallback((): void => {
    apiClient
      .update.updateStatus()
      .then(setStatus)
      .catch(() => {}); // a status that cannot be read is no status; the next event retries
  }, []);
  useEffect(load, [load]);
  useServerEvent("update", useCallback(() => load(), [load]));

  const progress = status?.progress ?? null;
  const busy = starting || (progress !== null && progress.finishedAt === undefined);
  // Fast while an update runs, so the step plan moves with it; a stopped or finished one does
  // not change again without an action.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [busy, load]);

  // The tip one notice stands for: the newest incoming commit. None means nothing to notice.
  const tip = status?.eligible && status.behind > 0 ? status.commits[0]?.sha : undefined;
  useEffect(() => {
    if (tip === undefined) {
      setNotified(null);
      return;
    }
    if (!dialog && tip !== getPref(NOTICE_KEY)) setNotified(tip);
  }, [tip, dialog]);

  // Answering the notice — dismissing it or opening the dialog — silences it for this tip.
  const answered = useCallback((seen: string | null): void => {
    if (seen !== null) setPref(NOTICE_KEY, seen);
    setNotified(null);
  }, []);

  const open = useCallback((): void => {
    answered(tip ?? null);
    setError(null);
    setDialog(true);
  }, [answered, tip]);
  const close = useCallback((): void => setDialog(false), []);

  const check = useCallback((): void => {
    setChecking(true);
    setError(null);
    apiClient
      .update.checkUpdate()
      .then(setStatus)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setChecking(false));
  }, []);

  const start = useCallback((): void => {
    setStarting(true);
    setError(null);
    apiClient
      .update.startUpdate()
      .then(setStatus)
      .catch((cause: unknown) => {
        // A failure inside the run lands in the journal and the reload below shows it; this
        // catches the ones before it started (a refusal, another run).
        setError(cause instanceof Error ? cause.message : String(cause));
        load();
      })
      .finally(() => setStarting(false));
  }, [load]);

  return {
    status,
    dialog,
    notice: notified !== null,
    busy,
    error,
    checking,
    open,
    close,
    dismissNotice: () => answered(notified),
    check,
    start,
    restart: () => hostOf()?.restart(),
    canRestart: hostOf() !== undefined,
  };
}
