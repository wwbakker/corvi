import type { ComponentType } from "react";
import type { Change } from "../../domain/change.ts";

/** A client-drawn widget an extension adds to a change's dashboard, beside the server-drawn
 * cards. The widget exists for a change when the extension does in the change's workspace, and
 * its client half exports `widget`. */
export type DashboardWidget = {
  /** The widget's identity within its extension, and the key the page knows it by. */
  id: string;
  /** What the widget's heading says, when the component does not draw its own. */
  title: string;
  /** Which dashboard column the widget belongs to: the change's documents on the left, or the
   * status widgets on the right (the default). A document is client state a server card cannot
   * hold — a textarea's debounce and unsaved marker. */
  column?: "left" | "right";
};

/** What a dashboard widget gets: the change it is about, and the workspace that change belongs
 * to — the same props as a change tab, on a different surface. */
export type WidgetComponent = ComponentType<{ change: Change; workspace?: string }>;
