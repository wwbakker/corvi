import { type JSX, type ComponentType } from "react";
import type { Change, Selection } from "../app-root/api.ts";
import * as azureDevopsClient from "./azure-devops/client.tsx";
import * as githubIssuesClient from "./github-issues/client.tsx";
import * as gitClient from "./git/client.tsx";
import * as jiraClient from "./jira/client.tsx";
import * as leftoversClient from "./leftovers/client.tsx";
import * as notesClient from "./notes/client.tsx";
import * as reviewClient from "./review/client.tsx";

/**
 * The client halves of the included integrations, and the hosts that render them.
 *
 * An integration's interface is a React component it ships next to its server half, exported as
 * `step` (a wizard step), `page` (a page the sidebar offers), `tab` (a tab on a change's page)
 * or `widget` (a client-drawn widget on a change's dashboard) — or any combination. The modules
 * are imported directly here: the server decides what a workspace has, the page renders what it
 * is told, and there is no runtime chunk to fetch or registry to consult.
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
  /** This extension's own slot in the draft in hand — what `setPayload` last set, and what a
   * step that was left and reopened reads back to restore its own selection. */
  payload: (extension: string) => unknown;
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

/** What a card's editor gets: the change it edits and the workspace that change belongs to,
 * the dialog's open state, and the two exits — nothing changed (`onClose`), or the change as
 * the write returned it (`onSaved`). The editor fetches through its own extension's routes, as
 * a wizard step does. */
export type EditComponent = ComponentType<{
  change: Change;
  workspace?: string;
  open: boolean;
  onClose: () => void;
  onSaved: (change: Change) => void;
}>;

export type ClientModule = {
  step?: StepComponent;
  page?: PageComponent;
  tab?: TabComponent;
  widget?: WidgetComponent;
  /** The editor behind the card's pencil. A card is editable when its declaration says so
   * (`CardInfo.editable`) and its integration ships this. */
  edit?: EditComponent;
};

/** One extension's client-drawn widget on a change's dashboard. */
export type WidgetInfo = {
  id: string;
  title: string;
  extension: string;
  column?: "left" | "right";
};

/** The included integrations' client halves, imported directly. Keyed by the integration's
 * name, which is what the server's contribution lists carry. */
const clients: Record<string, ClientModule> = {
  jira: jiraClient,
  "github-issues": githubIssuesClient,
  "azure-devops": azureDevopsClient,
  git: gitClient,
  leftovers: leftoversClient,
  review: reviewClient,
  notes: notesClient,
};

/** The editor an integration's client half ships for its card, when it has one. */
export const editorOf = (extension: string): EditComponent | undefined =>
  clients[extension]?.edit;

/** One integration's step. The server only offers steps whose integration is enabled and every
 * included step ships a client half; a disagreement is said rather than rendered blank. */
export function StepHost({ info, ctx }: { info: StepInfo; ctx: StepContext }): JSX.Element {
  const Step = clients[info.extension]?.step;
  if (!Step) return <div className="error-banner">{info.extension} has no step on this side</div>;
  return <Step ctx={ctx} />;
}

/** One integration's page, the same contract. */
export function PageHost({
  info,
  workspace,
}: {
  info: { id: string; extension: string };
  workspace?: string;
}): JSX.Element {
  const Page = clients[info.extension]?.page;
  if (!Page) return <div className="error-banner">{info.extension} has no page on this side</div>;
  return <Page workspace={workspace} />;
}

/** One integration's change tab, the same contract. */
export function TabHost({
  info,
  change,
  workspace,
}: {
  info: { id: string; title: string; extension: string };
  change: Change;
  workspace?: string;
}): JSX.Element {
  const Tab = clients[info.extension]?.tab;
  if (!Tab) return <div className="error-banner">{info.extension} has no tab on this side</div>;
  return <Tab change={change} workspace={workspace} />;
}

/** One integration's dashboard widget, the same contract. */
export function WidgetHost({
  info,
  change,
  workspace,
}: {
  info: WidgetInfo;
  change: Change;
  workspace?: string;
}): JSX.Element {
  const Widget = clients[info.extension]?.widget;
  if (!Widget) return <div className="error-banner">{info.extension} has no widget on this side</div>;
  return <Widget change={change} workspace={workspace} />;
}
