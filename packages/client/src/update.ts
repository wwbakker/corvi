/** The app's update: what is new, checking for it, and taking it. */
import { AppUpdateStatusSchema, type AppUpdateStatusDto } from "@corvi/contracts/api";

import { decode, type RequestOptions, type Send, request } from "./transport.ts";

export interface UpdateApi {
  /** What the app knows about updating itself: eligible, what is new, and the update journal.
   * Local reads only — the check runs on its own cadence, or when `check` asks. */
  readonly status: (options?: RequestOptions) => Promise<AppUpdateStatusDto>;
  /** Runs a check now (one fetch), and answers with the fresh status. */
  readonly check: (options?: RequestOptions) => Promise<AppUpdateStatusDto>;
  /** Starts the update and answers at once with the opening status — 202 while the steps run in
   * the background. A page watches the journal (`status().progress`), so a reload shows where
   * the run is. */
  readonly start: (options?: RequestOptions) => Promise<AppUpdateStatusDto>;
}

export const makeUpdateApi = (send: Send): UpdateApi => ({
  status: async (options) => request(send, "GET", "/app/update", AppUpdateStatusSchema, options),
  check: async (options) => request(send, "POST", "/app/update/check", AppUpdateStatusSchema, options),
  start: async (options) => request(send, "POST", "/app/update", AppUpdateStatusSchema, options),
});
