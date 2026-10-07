/** Named network operations for browser consumers, by domain.
 *
 * One entrypoint, one transport, domain namespaces: `client.changes.complete(input)` and
 * friends. Request and response types come from the canonical contracts schema, so the server
 * and the client cannot disagree silently, and a failure is a classified `ClientError` rather
 * than a bare `Error`.
 */
import { makeActionsApi, type ActionsApi } from "./actions.ts"
import { makeChangesApi, type ChangesApi } from "./changes.ts"
import { makeDashboardApi, type DashboardApi } from "./dashboard.ts"
import { makeDevicesApi, type DevicesApi } from "./devices.ts"
import { makePowerApi, type PowerApi } from "./power.ts"
import { makeRepositoriesApi, type RepositoriesApi } from "./repositories.ts"
import { makeServerApi, type ServerApi } from "./server.ts"
import { makeSettingsApi, type SettingsApi } from "./settings.ts"
import { makeSubagentsApi, type SubagentsApi } from "./subagents.ts"
import { makeTailscaleApi, type TailscaleApi } from "./tailscale.ts"
import { makeTerminalsApi, type TerminalsApi } from "./terminals.ts"
import { makeUpdateApi, type UpdateApi } from "./update.ts"
import { makeWizardApi, type WizardApi } from "./wizard.ts"
import { makeWorkspacesApi, type WorkspacesApi } from "./workspaces.ts"
import { transport, type ClientOptions } from "./transport.ts"

export interface CorviClient {
  readonly changes: ChangesApi
  readonly dashboard: DashboardApi
  readonly devices: DevicesApi
  readonly power: PowerApi
  readonly terminals: TerminalsApi
  readonly repositories: RepositoriesApi
  readonly wizard: WizardApi
  readonly workspaces: WorkspacesApi
  readonly settings: SettingsApi
  readonly actions: ActionsApi
  readonly subagents: SubagentsApi
  readonly tailscale: TailscaleApi
  readonly update: UpdateApi
  readonly server: ServerApi
}

export const makeCorviClient = (options: ClientOptions): CorviClient => {
  const { send } = transport(options)
  return {
    changes: makeChangesApi(send),
    dashboard: makeDashboardApi(send),
    devices: makeDevicesApi(send),
    power: makePowerApi(send),
    terminals: makeTerminalsApi(send),
    repositories: makeRepositoriesApi(send),
    wizard: makeWizardApi(send),
    workspaces: makeWorkspacesApi(send),
    settings: makeSettingsApi(send),
    actions: makeActionsApi(send),
    subagents: makeSubagentsApi(send),
    tailscale: makeTailscaleApi(send),
    update: makeUpdateApi(send),
    server: makeServerApi(send),
  }
}

export { ClientError, directoryListingQuery, makeWireClient } from "./transport.ts"
export type {
  ClientOptions,
  FetchLike,
  RequestOptions,
  WireClient,
} from "./transport.ts"
export type { DirectoryListingSpec, WidgetItemDto } from "@corvi/contracts/api"
