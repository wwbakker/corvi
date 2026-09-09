import type { IweExtensionApi } from "../api.ts";
import { git } from "../../integrations/git.ts";

/**
 * Local changes: the worktree card. The implementation lives where it always has
 * (src/integrations/git.ts), because half the core — completing, cancelling, committing,
 * browsing — shares its helpers. This extension is the card's registration: what the dashboard
 * shows, contributed like any extension's.
 */
export default function (api: IweExtensionApi) {
  api.registerCard(git);
}
