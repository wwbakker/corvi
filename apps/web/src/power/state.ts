/** The power control's state: the machine list, each machine's last read, the selection, and the
 * arm/disarm actions.
 *
 * Every machine is read through its own client (this server, or a remote through the gateway),
 * so a remote's own server produces its agent list. A failed read keeps the last known state (a
 * disarm must still reach a machine that has gone quiet) but drops the machine from the
 * selection and marks it unarmable — it is never read as "no agents", the one mistake that could
 * arm a machine that cannot see a running agent. Arm and disarm always go to the local server,
 * which fans out.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PowerTargetResultDto } from "@corvi/contracts/power";

import { useServerEvent } from "../app-root/events.ts";
import { gateFailureOf, statusOf } from "../app-root/sourceOwner.ts";
import { useAvailability, useSourceOwner } from "../app-root/sources.ts";
import type { Workspace } from "../workspace/client/workspaces.ts";
import {
  armable as armableSelection,
  powerFromSource,
  powerMachines,
  pruneSelection,
  type MachineRead,
  type PowerMachine,
} from "./model.ts";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One machine and what the last read said about it. `state` is the last known state even when
 * the latest read failed; `error` is that failure, if any. */
export type MachineReading = {
  readonly machine: PowerMachine;
  readonly state: MachineRead["state"];
  readonly error: string | null;
};

export type PowerView = {
  readonly open: boolean;
  readonly openDialog: () => void;
  readonly closeDialog: () => void;
  readonly readings: readonly MachineReading[];
  readonly selected: ReadonlySet<string>;
  readonly toggle: (source: string) => void;
  /** Whether every selected machine has a current, successful read to arm on. */
  readonly armable: boolean;
  readonly arm: () => void;
  readonly disarm: () => void;
  readonly busy: boolean;
  /** The last arm/disarm's per-target results; null before one has run. */
  readonly results: readonly PowerTargetResultDto[] | null;
  /** The last action's own failure, when the request never reached the fan-out. */
  readonly actionError: string | null;
};

export function usePower(workspaces: readonly Workspace[]): PowerView {
  const owner = useSourceOwner();
  const availability = useAvailability();
  const machines = useMemo(() => powerMachines(workspaces), [workspaces]);
  // A stable key over each machine's reachability and target generation: a remote going
  // checking -> available (or dropping, or retargeting) re-reads, while an unrelated render does
  // not. Local is `""` and always available.
  const statusKey = machines
    .map(
      (machine) =>
        `${machine.source}:${statusOf(availability, machine.source)._tag}:${availability.entries[machine.source]?.generation ?? ""}`,
    )
    .join("|");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(machines.filter((machine) => machine.selectedByDefault).map((machine) => machine.source)),
  );
  const [readings, setReadings] = useState<Record<string, MachineRead>>({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<readonly PowerTargetResultDto[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    for (const machine of machines) {
      owner
        .clientFor(machine.source)
        .power.state()
        .then((state) =>
          setReadings((all) => ({ ...all, [machine.source]: { state, error: null } })),
        )
        .catch((cause: unknown) => {
          // A gate refusal while a remote is checking or unavailable is expected: show the gate's
          // own reason rather than a bare failure. It stays unarmable until a read lands. Keep
          // the last known state (disarm needs it) and drop the machine from the selection, so a
          // machine that cannot be verified never blocks the readable ones.
          const error = gateFailureOf(cause)?.message ?? messageOf(cause);
          setReadings((all) => ({
            ...all,
            [machine.source]: { state: all[machine.source]?.state ?? null, error },
          }));
          setSelected((current) => {
            if (!current.has(machine.source)) return current;
            const next = new Set(current);
            next.delete(machine.source);
            return next;
          });
        });
    }
  }, [machines, owner]);

  // Read on mount, whenever the machine list changes, and whenever reachability or a target
  // generation changes, so a remote that was checking when the sidebar mounted is read the
  // moment it becomes available, and a machine that goes quiet while the dialog is closed is
  // already marked by the time it opens.
  useEffect(() => {
    refresh();
  }, [refresh, statusKey]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh, statusKey]);

  useServerEvent(
    "power",
    useCallback((): void => refresh(), [refresh]),
  );
  // A remote's power event arrives as a `source` envelope; only that event name refreshes.
  useServerEvent(
    "source",
    useCallback(
      (data: string): void => {
        if (powerFromSource(data)) refresh();
      },
      [refresh],
    ),
  );

  const openDialog = useCallback((): void => {
    // Prune anything whose last read failed before opening, so a poisoned selection cannot
    // survive a close/reopen.
    setSelected((current) => pruneSelection(current, readings));
    setResults(null);
    setActionError(null);
    setOpen(true);
  }, [readings]);
  const closeDialog = useCallback((): void => setOpen(false), []);

  const toggle = useCallback((source: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

  const send = useCallback(
    (verb: "arm" | "disarm", targets: readonly string[]): void => {
      setBusy(true);
      setActionError(null);
      owner
        .clientFor("")
        .power[verb](targets)
        .then((response) => {
          setResults(response.results);
          refresh();
        })
        .catch((cause: unknown) => setActionError(messageOf(cause)))
        .finally(() => setBusy(false));
    },
    [owner, refresh],
  );

  const arm = useCallback((): void => send("arm", [...selected]), [selected, send]);

  // Disarm whatever is armed — including a machine whose latest read failed but whose last known
  // phase was armed — plus anything still ticked.
  const disarm = useCallback((): void => {
    const armed = machines
      .map((machine) => machine.source)
      .filter((source) => {
        const phase = readings[source]?.state?.phase;
        return phase === "armed" || phase === "counting-down";
      });
    send("disarm", [...new Set([...armed, ...selected])]);
  }, [machines, readings, selected, send]);

  const list: readonly MachineReading[] = machines.map((machine) => ({
    machine,
    state: readings[machine.source]?.state ?? null,
    error: readings[machine.source]?.error ?? null,
  }));

  return {
    open,
    openDialog,
    closeDialog,
    readings: list,
    selected,
    toggle,
    armable: armableSelection(selected, readings),
    arm,
    disarm,
    busy,
    results,
    actionError,
  };
}
