/** Projection of the persisted legacy change record onto the new model.
 *
 * Read-only and total: it derives the phase mapping, the link set, and the deterministic link
 * ids from data the old record already carries. It grants no cleanup authority — provenance
 * (who created a checkout) is not recorded, so nothing here may authorize deletion.
 */
import { Schema } from "effect"

import {
  Change,
  ChangeId,
  DirectoryName,
  Repository,
  RepositoryId,
  type ChangePhase,
} from "@corvi/contracts/changes"

/** The stored record's fields, shared with the store that extends them. */
export const LegacyChangeRecordFields = {
  id: Schema.String,
  title: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  repos: Schema.optional(Schema.Array(Schema.String)),
  direct: Schema.optional(Schema.Array(Schema.String)),
  state: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
} as const

export const LegacyChangeRecord = Schema.Struct(LegacyChangeRecordFields)
export type LegacyChangeRecord = typeof LegacyChangeRecord.Type

/** The legacy phase names, including the two the new vocabulary renamed. */
/** The inverse: the old app's name for the same phase, written on save so both read the same
 * field. */
export const legacyStateForPhase = (phase: ChangePhase): string =>
  phase === "Implementation" ? "In Progress" : phase === "Verification" ? "Awaiting Review" : phase

export const mapLegacyPhase = (state: string | undefined): ChangePhase => {
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

const basename = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path

/** One link per source repository; in-place sources keep using their own checkout. */
export const projectLegacyRepositories = (record: LegacyChangeRecord): readonly Repository[] => {
  const seen = new Set<string>()
  const links: Repository[] = []
  for (const originalLocation of record.repos ?? []) {
    const directoryName = basename(originalLocation)
    if (seen.has(directoryName)) continue
    seen.add(directoryName)
    links.push(
      new Repository({
        changeId: ChangeId.make(record.id),
        repositoryId: RepositoryId.make(`${record.id}:${directoryName}`),
        directoryName: DirectoryName.make(directoryName),
        originalLocation,
        checkoutMethod: (record.direct ?? []).includes(originalLocation)
          ? "UseOriginalLocationNewBranch"
          : "UseNewLocationNewBranch",
      }),
    )
  }
  return links
}

export const projectLegacyChange = (record: LegacyChangeRecord, workspaceLocation: string): Change =>
  new Change({
    changeId: ChangeId.make(record.id),
    title: record.title ?? record.id,
    workspaceLocation,
    branch: record.branch ?? record.id,
    phase: mapLegacyPhase(record.state),
    createdAt: record.createdAt ?? "",
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  })
