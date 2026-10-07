import { type JSX, useEffect, useRef, useState } from "react";

import { blockersOf, formatCountdown, resultText } from "./model.ts";
import type { MachineReading, PowerView } from "./state.ts";

/**
 * The power dialog: the review step before machines power down. It lists each machine and the
 * agents that machine itself reports, so a missing reporter is visible before arming rather than
 * a surprise later. After arming it shows each machine waiting on its named blockers, or counting
 * down from the server's deadline on the page's own second.
 *
 * A machine whose read failed is not armable and cannot stay ticked, so it can never block the
 * readable machines; its last known state still shows, so a Disarm can reach it.
 */
export function PowerDialog({ view, onClose }: { view: PowerView; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const counting = view.readings.some((reading) => reading.state?.phase === "counting-down");
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  return (
    <dialog
      ref={ref}
      className="power-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h3>Power down when done</h3>
      <p className="hint">
        Each ticked machine powers itself off once no agent on it is working. This machine is
        ticked already; ticking a remote arms it too.
      </p>

      <ul className="power-machines">
        {view.readings.map((reading) => (
          <li key={reading.machine.source} className="power-machine">
            <label className="power-machine-head">
              <input
                type="checkbox"
                checked={view.selected.has(reading.machine.source)}
                disabled={reading.error !== null}
                onChange={() => view.toggle(reading.machine.source)}
              />
              <span>{reading.machine.label}</span>
            </label>
            <MachineBody reading={reading} now={now} />
          </li>
        ))}
      </ul>

      {view.actionError !== null && <p className="hint error">{view.actionError}</p>}
      {view.results !== null && (
        <ul className="power-results">
          {view.results.map((result, index) => (
            <li key={`${result.source}-${index}`}>
              {labelOf(view.readings, result.source)}: {resultText(result)}
            </li>
          ))}
        </ul>
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="primary"
          onClick={view.arm}
          disabled={view.busy || view.selected.size === 0 || !view.armable}
        >
          {view.busy ? "Arming…" : "Arm shutdown"}
        </button>
        <button type="button" onClick={view.disarm} disabled={view.busy}>
          Disarm
        </button>
      </div>
    </dialog>
  );
}

const labelOf = (readings: readonly MachineReading[], source: string): string =>
  readings.find((reading) => reading.machine.source === source)?.machine.label ??
  (source === "" ? "This machine" : source);

/** One machine's agents and phase. A failed read keeps the last known state visible and says the
 * failure, so nothing about the machine disappears. */
function MachineBody({ reading, now }: { reading: MachineReading; now: number }): JSX.Element {
  const state = reading.state;
  const stale = reading.error !== null;

  if (state === null) {
    return stale ? (
      <p className="hint error">cannot be read — {reading.error}; not armable</p>
    ) : (
      <p className="hint">reading…</p>
    );
  }

  const blockers = blockersOf(state.agents);
  return (
    <>
      {stale && (
        <p className="hint error">
          cannot be read — {reading.error}; showing the last known state
        </p>
      )}
      {state.agents.length === 0 ? (
        <p className="hint">no agents reported</p>
      ) : (
        <ul className="power-agents">
          {state.agents.map((agent) => (
            <li key={agent.label} className={agent.working ? "working" : "idle"}>
              {agent.label} — {agent.working ? "working" : "waiting / done"}
            </li>
          ))}
        </ul>
      )}
      {state.error !== undefined && <p className="hint error">{state.error}</p>}
      {state.phase === "counting-down" && state.deadline !== undefined && (
        <p className="hint">
          {stale ? "last known: " : ""}powers off in {formatCountdown(state.deadline, now)}
        </p>
      )}
      {state.phase === "armed" && (
        <p className="hint">
          {stale ? "last known: " : ""}
          {blockers.length === 0
            ? "waiting for the next check"
            : `waiting for ${blockers.join(", ")}`}
        </p>
      )}
    </>
  );
}
