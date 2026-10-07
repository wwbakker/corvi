/** The power control's pure half: which machines there are to arm, what a per-target result
 * says, how the countdown reads, and which selections can be armed. No React and no fetch — the
 * hook and the dialog compose these.
 */
import type {
  PowerAgent,
  PowerStateDto,
  PowerTargetResultDto,
  PowerTargetStatus,
} from "@corvi/contracts/power";
import type { Workspace } from "../workspace/client/workspaces.ts";

/** One machine the control can arm: this machine, or a remote workspace's server. */
export type PowerMachine = {
  /** The source id `clientFor` takes: `""` for this machine, the workspace id for a remote. */
  readonly source: string;
  readonly label: string;
  /** A remote's url; absent for this machine. Two workspaces naming the same url are one machine. */
  readonly url?: string;
  /** Selected when the dialog opens: this machine is, the remotes are not. */
  readonly selectedByDefault: boolean;
};

/** A remote url in the one form dedupe can compare: a trailing slash and the case of the scheme
 * and host are not a different machine. A url `URL` cannot parse is compared trimmed. */
export const normalizeRemoteUrl = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url.replace(/\/+$/, "");
  }
};

/** The machines to offer, in order: this machine, then each remote workspace, deduped by the
 * remote's normalized url (the first workspace naming a url wins). */
export const powerMachines = (workspaces: readonly Workspace[]): readonly PowerMachine[] => {
  const machines: PowerMachine[] = [
    { source: "", label: "This machine", selectedByDefault: true },
  ];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const remote = workspace.remote;
    if (remote === undefined) continue;
    const url = normalizeRemoteUrl(remote.url);
    if (seen.has(url)) continue;
    seen.add(url);
    machines.push({
      source: workspace.id,
      label: workspace.name,
      url,
      selectedByDefault: false,
    });
  }
  return machines;
};

/** One machine's last read: the last known state, kept through a failure so a disarm can still
 * reach a machine whose read has gone stale, and the failure when the last read didn't land. */
export type MachineRead = {
  readonly state: PowerStateDto | null;
  readonly error: string | null;
};

/** Whether a machine has a current, successful read to arm on: a state has landed and the latest
 * attempt did not fail. An unread machine is not armable. */
export const isArmable = (read: MachineRead | undefined): boolean =>
  read !== undefined && read.state !== null && read.error === null;

/** Whether every selected machine is armable. An empty selection is armable; the dialog's own
 * button still refuses zero machines. */
export const armable = (
  selected: ReadonlySet<string>,
  readings: Readonly<Record<string, MachineRead>>,
): boolean => [...selected].every((source) => isArmable(readings[source]));

/** Drop the selected sources whose read failed, so a machine that cannot be verified never
 * blocks the readable ones. A source not read yet is left alone: its first read decides. */
export const pruneSelection = (
  selected: ReadonlySet<string>,
  readings: Readonly<Record<string, MachineRead>>,
): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const source of selected) {
    if (readings[source]?.error == null) next.add(source);
  }
  return next;
};

/** The headline for one target's power result. */
export const statusLabel = (status: PowerTargetStatus): string => {
  switch (status) {
    case "armed":
      return "Armed";
    case "disarmed":
      return "Disarmed";
    case "unreachable":
      return "Unreachable";
    case "unsupported":
      return "Not supported";
    case "refused":
      return "Refused";
  }
};

/** One result as a sentence: its headline, plus the server's own words when it gave any. */
export const resultText = (result: PowerTargetResultDto): string =>
  result.detail === undefined
    ? statusLabel(result.status)
    : `${statusLabel(result.status)} — ${result.detail}`;

/** The labels of the agents still blocking a machine. */
export const blockersOf = (agents: readonly PowerAgent[]): readonly string[] =>
  agents.filter((agent) => agent.working).map((agent) => agent.label);

/** Milliseconds left before a deadline, never negative. */
export const remainingMs = (deadline: string, now: number): number =>
  Math.max(0, Date.parse(deadline) - now);

/** A deadline as a countdown: `m:ss` when a minute or more is left, otherwise `Ns`. */
export const formatCountdown = (deadline: string, now: number): string => {
  const total = Math.ceil(remainingMs(deadline, now) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${total}s`;
};

/** Whether a `source` envelope's data names a remote `power` event — the one remote event that
 * means a machine's power state changed. Another event or a malformed payload is not. */
export const powerFromSource = (data: string): boolean => {
  try {
    const envelope = JSON.parse(data) as { event?: unknown };
    return envelope.event === "power";
  } catch {
    return false;
  }
};
