/** The change's dashboard: its cards, tabs, widgets and per-repository rows. */
import {
  CardInfoSchema,
  ChangeTabsResponseSchema,
  ChangeWidgetsResponseSchema,
  RepoItemsSchema,
  WidgetSchema,
  type CardInfoDto,
  type ChangeTabInfoDto,
  type RepoItemsDto,
  type WidgetDto,
  type WidgetInfoDto,
} from "@corvi/contracts/api";
import type { ChangeId } from "@corvi/contracts/changes";

import { changePath, mutableArray, type RequestOptions, type Send, request } from "./transport.ts";

export interface DashboardApi {
  readonly cards: (changeId: ChangeId, options?: RequestOptions) => Promise<CardInfoDto[]>;
  readonly tabs: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeTabInfoDto[]>;
  readonly widgets: (changeId: ChangeId, options?: RequestOptions) => Promise<WidgetInfoDto[]>;
  readonly card: (changeId: ChangeId, card: string, options?: RequestOptions) => Promise<WidgetDto>;
  readonly cardRepo: (
    changeId: ChangeId,
    card: string,
    repo: string,
    options?: RequestOptions,
  ) => Promise<RepoItemsDto>;
  readonly cardAction: (changeId: ChangeId, card: string, action: string, arg?: string) => Promise<WidgetDto>;
  readonly cardRepoAction: (
    changeId: ChangeId,
    card: string,
    action: string,
    arg?: string,
  ) => Promise<RepoItemsDto>;
}

export const makeDashboardApi = (send: Send): DashboardApi => {
  const change = changePath;
  const cardPath = (changeId: ChangeId, card: string): string =>
    `${change(changeId)}/cards/${encodeURIComponent(card)}`;

  return {
    cards: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/cards`, mutableArray(CardInfoSchema), options),
    tabs: async (changeId, options) =>
      (await request(send, "GET", `${change(changeId)}/tabs`, ChangeTabsResponseSchema, options)).tabs,
    widgets: async (changeId, options) =>
      (await request(send, "GET", `${change(changeId)}/widgets`, ChangeWidgetsResponseSchema, options))
        .widgets,
    card: async (changeId, card, options) =>
      request(send, "GET", cardPath(changeId, card), WidgetSchema, options),
    cardRepo: async (changeId, card, repo, options) =>
      request(
        send,
        "GET",
        `${cardPath(changeId, card)}/items?path=${encodeURIComponent(repo)}`,
        RepoItemsSchema,
        options,
      ),
    cardAction: async (changeId, card, action, arg) =>
      request(
        send,
        "POST",
        `${cardPath(changeId, card)}/actions/${encodeURIComponent(action)}`,
        WidgetSchema,
        {
          body: arg === undefined ? {} : { arg },
        },
      ),
    cardRepoAction: async (changeId, card, action, arg) =>
      request(
        send,
        "POST",
        `${cardPath(changeId, card)}/actions/${encodeURIComponent(action)}`,
        RepoItemsSchema,
        {
          body: arg === undefined ? {} : { arg },
        },
      ),
  };
};
