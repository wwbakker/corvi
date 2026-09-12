import type { TabComponent } from "../../extension-host/client.tsx";
import { LocalPane } from "./LocalPane.tsx";

/**
 * The review extension's browser half: the tab the change page renders when the tab exists for
 * the change's workspace. The change and its workspace arrive through the tab contract; the
 * component below is the same local-changes pane, now driven by the extension's own routes.
 */
export const tab: TabComponent = ({ change, workspace }) => (
  <LocalPane change={change} workspace={workspace} />
);
