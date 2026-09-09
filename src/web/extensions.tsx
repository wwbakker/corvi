import { useEffect, useState, type ComponentType } from "react";
import type { Selection } from "./api.ts";

/**
 * The client halves of the extensions, and the host that renders them.
 *
 * An extension's interface is a React component it ships next to its server half, exported as
 * `step`. While extensions are built-ins, the registry below is plain build-time dynamic
 * imports: the bundler makes each its own chunk, loaded the first time a page renders that
 * extension's step. When out-of-tree extensions arrive this becomes a fetch of a chunk the
 * server built; the contract — one module exporting `step` — stays, which is why the server,
 * not the page, decides what exists: the wizard is told the steps, and renders what it is told.
 */

/** What the wizard has in hand while its steps run, shared between them. */
export type StepContext = {
  /** The context the change will be made in. */
  workspace?: string;
  /** The change id and branch — editable on the details step, prefillable by any issue step,
   * wherever in the order that step sits. */
  draft: { id: string; branch: string };
  setDraft: (patch: Partial<{ id: string; branch: string }>) => void;
  /** The repositories picked so far: what a repos-phase step looks at. */
  repos: Selection[];
  /** What the details step shows as the change's ticket: whatever an issue step last picked. */
  ticket?: string;
  setTicket: (label: string | undefined) => void;
  /** The step's contribution to the change record, stored under the extension's own name in the
   * change's `extensions` bag. Undefined removes it, which is what clearing a selection means. */
  setPayload: (extension: string, data: unknown) => void;
};

export type StepComponent = ComponentType<{ ctx: StepContext }>;

export type StepInfo = { id: string; extension: string; title: string; phase: "issue" | "repos" };

export const clients: Record<string, () => Promise<{ step: StepComponent }>> = {
  jira: () => import("../extensions/jira/client.tsx"),
  "github-issues": () => import("../extensions/github-issues/client.tsx"),
};

/** One extension's step, with its client module loaded the first time it is shown. A step whose
 * extension has no interface (or whose module fails to load) says so rather than vanishing. */
export function StepHost({ info, ctx }: { info: StepInfo; ctx: StepContext }) {
  const [Step, setStep] = useState<StepComponent>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = clients[info.extension];
    if (!load) {
      setError(`${info.extension} has no interface on this page`);
      return;
    }
    load()
      .then((m) => {
        if (alive) setStep(() => m.step);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [info.extension]);
  if (error) return <div className="error-banner">{error}</div>;
  if (!Step) return <p className="hint">loading…</p>;
  return <Step ctx={ctx} />;
}
