/** The repository browser the wizard and the settings picker share: listing directories and the
 * branches a checkout may name. */
import {
  BranchesSchema,
  DirectoryListingSchema,
  type BranchesDto,
  type DirectoryListingDto,
  type DirectoryListingSpec,
} from "@corvi/contracts/api";

import { decode, directoryListingQuery, type RequestOptions, type Send, request } from "./transport.ts";

export interface RepositoriesApi {
  readonly directories: (
    spec: DirectoryListingSpec,
    options?: RequestOptions,
  ) => Promise<DirectoryListingDto>;
  readonly branches: (path: string, options?: RequestOptions) => Promise<BranchesDto>;
}

export const makeRepositoriesApi = (send: Send): RepositoriesApi => ({
  directories: async (spec, options) => {
    const query = directoryListingQuery(spec);
    return request(send, "GET", `/repos${query ? `?${query}` : ""}`, DirectoryListingSchema, options);
  },
  branches: async (path, options) =>
    request(send, "GET", `/repos/branches?path=${encodeURIComponent(path)}`, BranchesSchema, options),
});
