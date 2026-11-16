/** The settings view and its file: reading what is configured, writing what should be. */
import { SettingsViewSchema, type SettingsViewDto } from "@corvi/contracts/api";
import type { ConfigFileDto } from "@corvi/contracts/config";

import { decode, type RequestOptions, type Send, request } from "./transport.ts";

export interface SettingsApi {
  readonly read: (options?: RequestOptions) => Promise<SettingsViewDto>;
  readonly write: (settings: ConfigFileDto) => Promise<SettingsViewDto>;
}

export const makeSettingsApi = (send: Send): SettingsApi => ({
  read: async (options) => request(send, "GET", "/settings", SettingsViewSchema, options),
  write: async (settings) => request(send, "PUT", "/settings", SettingsViewSchema, { body: settings }),
});
