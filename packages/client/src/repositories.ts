/** The repository browser the wizard and the settings picker share: listing directories and the
 * branches a checkout may name. */
import {
  BranchesSchema,
  DirectoryListingSchema,
  type BranchesDto,
  type DirectoryListingDto,
  type DirectoryListingSpec,
} from "@corvi/contracts/api"

import {
  decode,
  directoryListingQuery,
  type RequestOptions,
  type Send,
} from "./transport.ts"

export interface RepositoriesApi {
  readonly directories: (
    spec: DirectoryListingSpec,
    options?: RequestOptions,
  ) => Promise<DirectoryListingDto>
  readonly branches: (path: string, options?: RequestOptions) => Promise<BranchesDto>
}

export const makeRepositoriesApi = (send: Send): RepositoriesApi => ({
  directories: async (spec, options) => {
    const query = directoryListingQuery(spec)
    return decode(
      DirectoryListingSchema,
      await send("GET", `/repos${query ? `?${query}` : ""}`, options),
    )
  },
  branches: async (path, options) =>
    decode(
      BranchesSchema,
      await send("GET", `/repos/branches?path=${encodeURIComponent(path)}`, options),
    ),
})
