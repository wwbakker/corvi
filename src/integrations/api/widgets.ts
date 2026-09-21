import type { ComponentType } from "react";

import type { Change } from "../../domain/change.ts";

/** A client-drawn dashboard widget's declaration, as `@corvi/contracts/integration` states it. */
export type { DashboardWidget } from "@corvi/contracts/integration";

/** What a dashboard widget gets: the change it is about, and the workspace that change belongs
 * to — the same props as a change tab, on a different surface. The component type stays here
 * because it is browser code; the contract describes the declaration, not the React surface. */
export type WidgetComponent = ComponentType<{ change: Change; workspace?: string }>;
