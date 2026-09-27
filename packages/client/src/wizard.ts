/** The change wizard: the steps a new change walks through and the plan template it starts. */
import {
  WizardResponseSchema,
  type WizardResponseDto,
} from "@corvi/contracts/api"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface WizardApi {
  readonly spec: (workspace?: string, options?: RequestOptions) => Promise<WizardResponseDto>
}

export const makeWizardApi = (send: Send): WizardApi => ({
  spec: async (workspace, options) =>
    decode(
      WizardResponseSchema,
      await send(
        "GET",
        `/wizard${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
        options,
      ),
    ),
})
