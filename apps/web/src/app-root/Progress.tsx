import { type JSX, useEffect, useState } from "react";

export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** Elapsed time against a pipeline's recent typical duration. Ticks locally so the clock is smooth
 * between the caller's refreshes; overruns fill the bar and keep counting. Shared between the CI
 * widget's runs, the deployment dialog's in-progress builds and the deployments page's deploying
 * cells — the same question ("how much longer?") asked from three pages. The tooltip carries both
 * numbers, which is what a narrow cell has room for instead of the elapsed text. */
export function Progress({ startedAt, expectedMs }: { startedAt: string; expectedMs?: number }): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = now - new Date(startedAt).getTime();
  const fraction = expectedMs ? Math.min(elapsed / expectedMs, 1) : undefined;
  // The numbers, once, for both the tooltip and the accessible name: a narrow cell hides the
  // elapsed text, and a screen reader must not lose it with it.
  const label = expectedMs === undefined
    ? `${duration(elapsed)} elapsed`
    : `${duration(elapsed)} elapsed, typically ${duration(expectedMs)}`;
  return (
    <span className="progress" role="img" aria-label={label} title={label}>
      <span className="bar">
        <span
          className={`fill ${fraction === undefined ? "unknown" : elapsed > (expectedMs ?? 0) ? "over" : ""}`}
          style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }}
        />
      </span>
      <span className="elapsed">
        {duration(elapsed)}
        {expectedMs ? ` / ~${duration(expectedMs)}` : ""}
      </span>
    </span>
  );
}
