/** The harness-profile server's public face for the modules that launch panes: the change's
 * discovery and pane environments, plus the resolver a create and a reopen share.
 *
 * The pages and routes read `./files.ts`, `./views.ts` and `./choices.ts` directly; keeping this
 * surface small keeps the launch contract readable. */
export {
  harnessProfileDiscoveryFor,
  resolvePaneHarnessProfile,
  resolveSubagentHarnessProfile,
  type PaneHarnessProfileSelection,
  type SubagentHarnessProfileDecision,
} from "./selection.ts";
export {
  subagentHarnessProfileLaunch,
  userHarnessProfileLaunch,
  withWarningsLine,
  type EnvironmentLaunch,
} from "./env.ts";
