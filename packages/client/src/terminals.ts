/** The change's terminals: the window list, the terminal page's URL and window actions. */
import {
  TerminalsResponseSchema,
  TerminalWindowSchema,
  UrlSchema,
  WindowActionBodySchema,
  type TerminalWindowDto,
  type TerminalsResponseDto,
  type UrlDto,
  type WindowActionBodyDto,
} from "@corvi/contracts/api"
import type { ChangeId } from "@corvi/contracts/changes"

import {
  changePath,
  decode,
  mutableArray,
  type RequestOptions,
  type Send,
} from "./transport.ts"

export interface TerminalsApi {
  readonly list: (options?: RequestOptions) => Promise<TerminalsResponseDto>
  readonly url: (changeId: ChangeId, options?: RequestOptions) => Promise<UrlDto>
  readonly windowAction: (
    changeId: ChangeId,
    action: WindowActionBodyDto,
  ) => Promise<TerminalWindowDto[]>
}

export const makeTerminalsApi = (send: Send): TerminalsApi => {
  const change = changePath

  return {
    list: async (options) =>
      decode(TerminalsResponseSchema, await send("GET", "/terminals", options)),
    url: async (changeId, options) =>
      decode(UrlSchema, await send("GET", `${change(changeId)}/terminal`, options)),
    windowAction: async (changeId, action) =>
      decode(
        mutableArray(TerminalWindowSchema),
        await send("POST", `${change(changeId)}/terminal/windows`, { body: action }),
      ),
  }
}
