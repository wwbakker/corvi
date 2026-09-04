import { useEffect, useState } from "react";

export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** Elapsed time against a pipeline's recent average. Ticks locally so the clock is smooth
 * between the caller's refreshes; overruns fill the bar and keep counting. Shared between the CI
 * widget's runs and the deployment dialog's in-progress builds — the same question ("how much
 * longer?") asked from two different pages. */
export function Progress({ startedAt, expectedMs }: { startedAt: string; expectedMs?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = now - new Date(startedAt).getTime();
  const fraction = expectedMs ? Math.min(elapsed / expectedMs, 1) : undefined;
  return (
    <span className="progress" title={expectedMs ? `average ${duration(expectedMs)}` : undefined}>
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
