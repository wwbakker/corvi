/** The settings view and its file: reading what is configured, writing what should be. */
import { SettingsViewSchema, type SettingsViewDto } from "@corvi/contracts/api"
import type { ConfigFileDto } from "@corvi/contracts/config"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface SettingsApi {
  readonly settings: (options?: RequestOptions) => Promise<SettingsViewDto>
  readonly writeSettings: (settings: ConfigFileDto) => Promise<SettingsViewDto>
}

export const makeSettingsApi = (send: Send): SettingsApi => ({
  settings: async (options) =>
    decode(SettingsViewSchema, await send("GET", "/settings", options)),
  writeSettings: async (settings) =>
    decode(SettingsViewSchema, await send("PUT", "/settings", { body: settings })),
})
