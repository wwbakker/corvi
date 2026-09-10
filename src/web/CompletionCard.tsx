import { type JSX, useEffect, useState } from "react";
import { api, post, type Change } from "./api.ts";

export type CompletionStep = {
  id: string;
  label: string;
  state: "waiting" | "running" | "done" | "failed";
  detail?: string;
};

export type CompletionProgress = {
  startedAt: string;
  finishedAt?: string;
  steps: CompletionStep[];
  error?: string;
};

const MARK: Record<CompletionStep["state"], string> = {
  waiting: "○",
  running: "◍",
  done: "●",
  failed: "✕",
};

/**
 * What completing a change is doing, or where it stopped. Read from disk rather than remembered
 * in the page: a completion that fails half way has to be legible afterwards, and the page that
 * started it is often long gone.
 */
export function CompletionCard({
  changeId,
  busy,
  onFinished,
}: {
  changeId: string;
  /** A completion this page just asked for: read the progress at once rather than on the next
   * slow tick, so the card appears with the click. */
  busy: boolean;
  /** The change is archived when the last step is done; the view above needs to know. */
  onFinished: (change: Change) => void;
}): JSX.Element | null {
  const [progress, setProgress] = useState<CompletionProgress | null>(null);
  const [retrying, setRetrying] = useState(false);

  const running = busy || retrying || (progress !== null && !progress.finishedAt);

  useEffect(() => {
    const load = (): Promise<void> =>
      api<CompletionProgress | null>(`/changes/${changeId}/complete/progress`)
        .then(setProgress)
        .catch(() => {});
    void load();
    // Fast while it runs, slowly otherwise: a finished completion does not change again.
    const timer = setInterval(load, running ? 1000 : 15_000);
    return () => clearInterval(timer);
  }, [changeId, running]);

  const retry = (): void => {
    setRetrying(true);
    post<{ change: Change }>(`/changes/${changeId}/complete`, {})
      .then(({ change }) => onFinished(change))
      .catch(() => {}) // the failure lands in the progress itself, which is where it belongs
      .finally(() => setRetrying(false));
  };

  // A change that was never completed has nothing to show; every completion that did run keeps
  // its record, including the ones that went perfectly.
  if (!progress) return null;
  const done = progress.steps.filter((s) => s.state === "done").length;

  return (
    <section
      className={`widget completion ${progress.error ? "failed" : progress.finishedAt ? "finished" : ""}`}
    >
      <h3>
        Completing
        <span className="spacer" />
        <span className="summary">
          {progress.error
            ? "stopped"
            : progress.finishedAt
              ? `completed ${progress.finishedAt.slice(0, 16).replace("T", " ")}`
              : `${done} of ${progress.steps.length}`}
        </span>
      </h3>
      <ul className="progress-steps">
        {progress.steps.map((step) => (
          <li key={step.id} className={step.state}>
            <span className="mark">{MARK[step.state]}</span>
            {step.label}
            {step.detail && <span className="detail">{step.detail}</span>}
          </li>
        ))}
      </ul>
      {progress.error && (
        <p className="hint">
          Everything before this step is done; running it again picks up what is left.{" "}
          <button disabled={retrying} onClick={retry}>
            {retrying ? "Completing…" : "Try again"}
          </button>
        </p>
      )}
    </section>
  );
}
