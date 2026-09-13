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
  /** Ask for the wide column on a wide window, like a wide server card. */
  wide?: boolean;
};

/** What a dashboard widget gets: the change it is about, and the workspace that change belongs
 * to — the same props as a change tab, on a different surface. */
export type WidgetComponent = ComponentType<{ change: Change; workspace?: string }>;
