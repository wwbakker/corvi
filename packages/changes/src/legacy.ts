/** The record format 1 → 2 migration: one run per record, kept until no v1 records remain.
 *
 * A v1 record carries its repositories as `repos`/`direct`/`base` lists (and older Corvis
 * additionally a derived `repositories` array). This module is the only code that reads them.
 * It grants no cleanup authority — provenance (who created a checkout) is not recorded, so
 * nothing here may authorize deletion.
 */
import { Schema } from "effect"

import type { CheckoutSpecDto } from "@corvi/contracts/api"
import type { ChangePhase } from "@corvi/contracts/changes"

import { FORMAT_VERSION } from "./record.ts"

/** The stored v1 record's fields, kept for the decode the migration starts from. */
export const LegacyChangeRecordFields = {
  id: Schema.String,
  title: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  repos: Schema.optional(Schema.Array(Schema.String)),
  direct: Schema.optional(Schema.Array(Schema.String)),
  base: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  state: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
} as const

export const LegacyChangeRecord = Schema.Struct(LegacyChangeRecordFields)
export type LegacyChangeRecord = typeof LegacyChangeRecord.Type

/** The v1 state names mapped onto the current vocabulary — the two the rename touched
 * ("In Progress" → "Implementation", "Awaiting Review" → "Verification") and the rest carried
 * over. An unknown name is started work, which is what the old default was. */
export const mapLegacyState = (state: string | undefined): ChangePhase => {
  switch (state) {
    case "Ideation":
      return "Ideation"
    case "Awaiting Review":
      return "Verification"
    case "Blocked":
      return "Blocked"
    case "Completed":
      return "Completed"
    case "Cancelled":
      return "Cancelled"
    default:
      return "Implementation"
  }
}

/** One v2 checkout spec per v1 repository path. `direct` membership is the only
 * original-location kind v1 knew, every v1 row's branch is the change's own, and a `base`
 * entry becomes both the spec's `base` and its `target`: one field served both roles before
 * they were split, so the migration preserves what a pull request targeted. */
const checkoutsOf = (input: {
  readonly repos?: readonly string[]
  readonly direct?: readonly string[]
  readonly base?: Record<string, string>
}): readonly CheckoutSpecDto[] =>
  (input.repos ?? []).map((path) => ({
    path,
    location: (input.direct ?? []).includes(path) ? ("original" as const) : ("new" as const),
    branch: { kind: "change" as const },
    ...(input.base?.[path] !== undefined ? { base: input.base[path], target: input.base[path] } : {}),
  }))

/** The record a v1 record becomes: `checkouts` replaces `repos`/`direct`/`base` (and any
 * derived `repositories`), `state` moves to the current vocabulary, and the record is stamped
 * with `formatVersion`. Unknown keys are carried over untouched. A record that already carries
 * `checkouts` keeps them: a hand-written record without the stamp is ahead of the migration,
 * not behind it. Run once per record — the stores persist the result atomically on the record's
 * next read. */
export const migrateRecord = (record: Record<string, unknown>): Record<string, unknown> => {
  const v1 = record as LegacyChangeRecord & Record<string, unknown>
  const { repos, direct, base, repositories: _derived, state, ...kept } = v1
  const checkouts = Array.isArray(kept.checkouts) ? kept.checkouts : checkoutsOf({ repos, direct, base })
  return {
    ...kept,
    state: mapLegacyState(state),
    formatVersion: FORMAT_VERSION,
    checkouts,
  }
}
