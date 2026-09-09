import { useEffect, useState, type ComponentType } from "react";
import type { Selection } from "./api.ts";

/**
 * The client halves of the extensions, and the host that renders them.
 *
 * An extension's interface is a React component it ships next to its server half, exported as
 * `step`. Built-ins are in the registry below — build-time dynamic imports, each made its own
 * chunk by the bundler, loaded the first time a page renders that extension's step. An
 * out-of-tree extension has no static entry: its client was never seen by the bundler, so
 * StepHost falls back to importing the chunk the server built and serves at
 * /extensions/<name>/client.js. The contract — one module exporting `step` — stays, which is
 * why the server, not the page, decides what exists: the wizard is told the steps, and
 * renders what it is told.
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

/** An import the bundler cannot resolve at build time: the specifier is computed, so it
 * stays a runtime import (verified against `bun build src/web/index.html`) and the request
 * goes to the server, which answers with the chunk it built for that extension. A static
 * import here would fail the whole page's build — the module does not exist at build time. */
const runtimeImport = (specifier: string): Promise<{ step: StepComponent }> => import(specifier);

/** One extension's step, with its client module loaded the first time it is shown. A step
 * whose extension has no static entry is an out-of-tree extension: its client chunk comes
 * from the server. A step whose module cannot be loaded at all says so rather than vanishing. */
export function StepHost({ info, ctx }: { info: StepInfo; ctx: StepContext }) {
  const [Step, setStep] = useState<StepComponent>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = clients[info.extension];
    const loader = load ?? (() => runtimeImport(`/extensions/${info.extension}/client.js`));
    loader()
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
