/** The change's dashboard: its cards, tabs, widgets and per-repository rows. */
import {
  CardInfoSchema,
  ChangeTabsResponseSchema,
  ChangeWidgetsResponseSchema,
  RepoItemsSchema,
  RepoStateSchema,
  WidgetSchema,
  type CardInfoDto,
  type ChangeTabInfoDto,
  type RepoItemsDto,
  type RepoStateDto,
  type WidgetDto,
  type WidgetInfoDto,
} from "@corvi/contracts/api"
import type { ChangeId } from "@corvi/contracts/changes"

import {
  changePath,
  decode,
  mutableArray,
  type RequestOptions,
  type Send,
} from "./transport.ts"

export interface DashboardApi {
  readonly cards: (changeId: ChangeId, options?: RequestOptions) => Promise<CardInfoDto[]>
  readonly tabs: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeTabInfoDto[]>
  readonly widgets: (changeId: ChangeId, options?: RequestOptions) => Promise<WidgetInfoDto[]>
  readonly repoStates: (changeId: ChangeId, options?: RequestOptions) => Promise<RepoStateDto[]>
  readonly card: (changeId: ChangeId, card: string, options?: RequestOptions) => Promise<WidgetDto>
  readonly cardRepo: (
    changeId: ChangeId,
    card: string,
    repo: string,
    options?: RequestOptions,
  ) => Promise<RepoItemsDto>
  readonly cardAction: (
    changeId: ChangeId,
    card: string,
    action: string,
    arg?: string,
  ) => Promise<WidgetDto>
  readonly cardRepoAction: (
    changeId: ChangeId,
    card: string,
    action: string,
    arg?: string,
  ) => Promise<RepoItemsDto>
}

export const makeDashboardApi = (send: Send): DashboardApi => {
  const change = changePath
  const cardPath = (changeId: ChangeId, card: string): string =>
    `${change(changeId)}/cards/${encodeURIComponent(card)}`

  return {
    cards: async (changeId, options) =>
      decode(mutableArray(CardInfoSchema), await send("GET", `${change(changeId)}/cards`, options)),
    tabs: async (changeId, options) =>
      decode(ChangeTabsResponseSchema, await send("GET", `${change(changeId)}/tabs`, options)).tabs,
    widgets: async (changeId, options) =>
      decode(ChangeWidgetsResponseSchema, await send("GET", `${change(changeId)}/widgets`, options))
        .widgets,
    repoStates: async (changeId, options) =>
      decode(mutableArray(RepoStateSchema), await send("GET", `${change(changeId)}/repos`, options)),
    card: async (changeId, card, options) =>
      decode(WidgetSchema, await send("GET", cardPath(changeId, card), options)),
    cardRepo: async (changeId, card, repo, options) =>
      decode(
        RepoItemsSchema,
        await send(
          "GET",
          `${cardPath(changeId, card)}/items?path=${encodeURIComponent(repo)}`,
          options,
        ),
      ),
    cardAction: async (changeId, card, action, arg) =>
      decode(
        WidgetSchema,
        await send("POST", `${cardPath(changeId, card)}/actions/${encodeURIComponent(action)}`, {
          body: arg === undefined ? {} : { arg },
        }),
      ),
    cardRepoAction: async (changeId, card, action, arg) =>
      decode(
        RepoItemsSchema,
        await send("POST", `${cardPath(changeId, card)}/actions/${encodeURIComponent(action)}`, {
          body: arg === undefined ? {} : { arg },
        }),
      ),
  }
}
