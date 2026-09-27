/** The app's update: what is new, checking for it, and taking it. */
import { AppUpdateStatusSchema, type AppUpdateStatusDto } from "@corvi/contracts/api"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface UpdateApi {
  /** What the app knows about updating itself: eligible, what is new, and the update journal.
   * Local reads only — the check runs on its own cadence, or when `checkUpdate` asks. */
  readonly updateStatus: (options?: RequestOptions) => Promise<AppUpdateStatusDto>
  /** Runs a check now (one fetch), and answers with the fresh status. */
  readonly checkUpdate: (options?: RequestOptions) => Promise<AppUpdateStatusDto>
  /** Starts the update and answers at once with the opening status — 202 while the steps run in
   * the background. A page watches the journal (`updateStatus().progress`), so a reload shows
   * where the run is. */
  readonly startUpdate: (options?: RequestOptions) => Promise<AppUpdateStatusDto>
}

export const makeUpdateApi = (send: Send): UpdateApi => ({
  updateStatus: async (options) =>
    decode(AppUpdateStatusSchema, await send("GET", "/app/update", options)),
  checkUpdate: async (options) =>
    decode(AppUpdateStatusSchema, await send("POST", "/app/update/check", options)),
  startUpdate: async (options) =>
    decode(AppUpdateStatusSchema, await send("POST", "/app/update", options)),
})
