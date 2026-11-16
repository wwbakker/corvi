/** The change's terminals: the window list, the terminal page's URL and window actions. */
import {
  TerminalsResponseSchema,
  TerminalWindowSchema,
  TerminalStatusResponseSchema,
  UrlSchema,
  WindowActionBodySchema,
  type TerminalWindowDto,
  type TerminalStatusDto,
  type TerminalStatusResponseDto,
  type TerminalsResponseDto,
  type UrlDto,
  type WindowActionBodyDto,
} from "@corvi/contracts/api";
import type { ChangeId } from "@corvi/contracts/changes";

import { changePath, mutableArray, type RequestOptions, type Send, request } from "./transport.ts";

export interface TerminalsApi {
  readonly list: (options?: RequestOptions) => Promise<TerminalsResponseDto>;
  readonly url: (changeId: ChangeId, options?: RequestOptions) => Promise<UrlDto>;
  readonly windowAction: (changeId: ChangeId, action: WindowActionBodyDto) => Promise<TerminalWindowDto[]>;
  /** Report an agent status for one host session (the CLI reporter transport). */
  readonly setStatus: (body: TerminalStatusDto) => Promise<TerminalStatusResponseDto>;
}

export const makeTerminalsApi = (send: Send): TerminalsApi => {
  const change = changePath;

  return {
    list: async (options) => request(send, "GET", "/terminals", TerminalsResponseSchema, options),
    url: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/terminal`, UrlSchema, options),
    windowAction: async (changeId, action) =>
      request(send, "POST", `${change(changeId)}/terminal/windows`, mutableArray(TerminalWindowSchema), {
        body: action,
      }),
    setStatus: async (body) =>
      request(send, "POST", "/terminals/status", TerminalStatusResponseSchema, { body }),
  };
};
