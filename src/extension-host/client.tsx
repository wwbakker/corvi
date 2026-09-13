import { type JSX, useEffect, useState, type ComponentType } from "react";
import type { Change, Selection } from "../app-root/api.ts";

/**
 * The client halves of the extensions, and the hosts that render them.
 *
 * An extension's interface is a React component it ships next to its server half, exported as
 * `step` (a wizard step), `page` (a page the sidebar offers), `tab` (a tab on a change's
 * page) or `widget` (a client-drawn widget on a change's dashboard) — or any combination.
 * Built-ins are in the registry below — build-time dynamic imports, each made its own chunk by
 * the bundler, loaded the first time a page renders that extension's step, page, tab or
 * widget. An out-of-tree extension has no static entry: its client was never seen by
 * the bundler, so StepHost, PageHost, TabHost and WidgetHost fall back to importing the chunk
 * the server built and serves at /extensions/<name>/client.js. The contract — one module
 * exporting `step` and/or `page` and/or `tab` and/or `widget` — stays, which is why the
 * server, not the page, decides what exists: the wizard is told the steps, the sidebar the
 * pages, the change page its tabs and the dashboard its widgets, and each renders what it is
 * told.
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

/** What a page of an extension's own gets: the context you are in. */
export type PageProps = { workspace?: string };

export type PageComponent = ComponentType<PageProps>;

/** What a change tab gets: the change it is about, and the workspace that change belongs to. */
export type TabComponent = ComponentType<{ change: Change; workspace?: string }>;

/** What a dashboard widget gets: the same props as a change tab, on the dashboard instead. */
export type WidgetComponent = ComponentType<{ change: Change; workspace?: string }>;

export type ClientModule = {
  step?: StepComponent;
  page?: PageComponent;
  tab?: TabComponent;
  widget?: WidgetComponent;
};

/** One extension's client-drawn widget on a change's dashboard. */
export type WidgetInfo = {
  id: string;
  title: string;
  extension: string;
  column?: "left" | "right";
};

export const clients: Record<string, () => Promise<ClientModule>> = {
  jira: () => import("../extensions/jira/client.tsx"),
  "github-issues": () => import("../extensions/github-issues/client.tsx"),
  "azure-devops": () => import("../extensions/azure-devops/client.tsx"),
  leftovers: () => import("../extensions/leftovers/client.tsx"),
  review: () => import("../extensions/review/client.tsx"),
  notes: () => import("../extensions/notes/client.tsx"),
};

/** An import the bundler cannot resolve at build time: the specifier is computed, so it
 * stays a runtime import (verified against `bun build src/app-root/index.html`) and the request
 * goes to the server, which answers with the chunk it built for that extension. A static
 * import here would fail the whole page's build — the module does not exist at build time. */
const runtimeImport = (specifier: string): Promise<ClientModule> => import(specifier);

/** One extension's step, with its client module loaded the first time it is shown. A step
 * whose extension has no static entry is an out-of-tree extension: its client chunk comes
 * from the server. A step whose module cannot be loaded at all says so rather than vanishing. */
export function StepHost({ info, ctx }: { info: StepInfo; ctx: StepContext }): JSX.Element {
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

/** One extension's page, the same way: the module loaded the first time the page is shown,
 * from the registry when the extension is built in, from the server's chunk when it is not. */
export function PageHost({
  info,
  workspace,
}: {
  info: { id: string; extension: string };
  workspace?: string;
}): JSX.Element {
  const [Page, setPage] = useState<PageComponent>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = clients[info.extension];
    const loader = load ?? (() => runtimeImport(`/extensions/${info.extension}/client.js`));
    loader()
      .then((m) => {
        if (!alive) return;
        // The server says the extension has a page; its client half is the other half of the
        // same claim. If they disagree, say so rather than render nothing.
        if (!m.page) setError(`${info.extension} has no page on this side`);
        else setPage(() => m.page);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [info.extension]);
  if (error) return <div className="error-banner">{error}</div>;
  if (!Page) return <p className="hint">loading…</p>;
  return <Page workspace={workspace} />;
}

/** One extension's change tab, the same way: the module loaded the first time the tab is shown,
 * from the registry when the extension is built in, from the server's chunk when it is not. An
 * extension that offered a tab server-side but exports none on this side says so. */
export function TabHost({
  info,
  change,
  workspace,
}: {
  info: { id: string; title: string; extension: string };
  change: Change;
  workspace?: string;
}): JSX.Element {
  const [Tab, setTab] = useState<TabComponent>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = clients[info.extension];
    const loader = load ?? (() => runtimeImport(`/extensions/${info.extension}/client.js`));
    loader()
      .then((m) => {
        if (!alive) return;
        if (!m.tab) setError(`${info.extension} has no tab on this side`);
        else setTab(() => m.tab);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [info.extension]);
  if (error) return <div className="error-banner">{error}</div>;
  if (!Tab) return <p className="hint">loading…</p>;
  return <Tab change={change} workspace={workspace} />;
}

/** One extension's dashboard widget, the same way: the module loaded the first time the
 * dashboard is shown, from the registry when the extension is built in, from the server's
 * chunk when it is not. An extension that offered a widget server-side but exports none on
 * this side says so. */
export function WidgetHost({
  info,
  change,
  workspace,
}: {
  info: WidgetInfo;
  change: Change;
  workspace?: string;
}): JSX.Element {
  const [Widget, setWidget] = useState<WidgetComponent>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = clients[info.extension];
    const loader = load ?? (() => runtimeImport(`/extensions/${info.extension}/client.js`));
    loader()
      .then((m) => {
        if (!alive) return;
        if (!m.widget) setError(`${info.extension} has no widget on this side`);
        else setWidget(() => m.widget);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [info.extension]);
  if (error) return <div className="error-banner">{error}</div>;
  if (!Widget) return <p className="hint">loading…</p>;
  return <Widget change={change} workspace={workspace} />;
}
