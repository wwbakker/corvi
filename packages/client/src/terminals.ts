/** The change's terminals: the window list, the terminal page's URL and window actions. */
import {
  TerminalsResponseSchema,
  TerminalWindowSchema,
  TerminalStatusResponseSchema,
  HostStatusSchema,
  TerminalAttachmentSchema,
  UrlSchema,
  WindowActionBodySchema,
  type HostStatusDto,
  type TerminalAttachmentDto,
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
  /** Store a file dropped or pasted into the change's terminal on the server that runs its ptys,
   * under `name` (a clash is renamed, not overwritten). The answer is where it was stored. */
  readonly attach: (
    changeId: ChangeId,
    name: string,
    file: Blob,
    options?: RequestOptions,
  ) => Promise<TerminalAttachmentDto>;
  /** Report an agent status for one host session (the CLI reporter transport). */
  readonly setStatus: (body: TerminalStatusDto) => Promise<TerminalStatusResponseDto>;
  /** The terminal host this server is talking to, and whether it is the one it would have started. */
  readonly hostStatus: (options?: RequestOptions) => Promise<HostStatusDto>;
  /** Replace the host. Ends every session it held, so the caller asks the user first. */
  readonly restartHost: () => Promise<HostStatusDto>;
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
    attach: async (changeId, name, file, options) =>
      request(
        send,
        "POST",
        `${change(changeId)}/terminal/attachments?name=${encodeURIComponent(name)}`,
        TerminalAttachmentSchema,
        { bytes: file, ...(options?.signal ? { signal: options.signal } : {}) },
      ),
    setStatus: async (body) =>
      request(send, "POST", "/terminals/status", TerminalStatusResponseSchema, { body }),
    hostStatus: async (options) => request(send, "GET", "/terminals/host", HostStatusSchema, options),
    restartHost: async () => request(send, "POST", "/terminals/host/restart", HostStatusSchema),
  };
};
