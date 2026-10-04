import { directoryListingQuery, type DirectoryListingSpec } from "@corvi/client";
import type { CorviClient } from "@corvi/client";
import { apiClient, type Listing } from "../../app-root/api.ts";

/** What a listing request says: where to list, which context's start directory to use when it
 * names none, and whether dot-directories are wanted. */
export type ListingSpec = DirectoryListingSpec;

/** The query the server reads, built once so the repository browser and the settings picker
 * cannot ask the same question differently. */
export const listingQuery = directoryListingQuery;

/** One directory's contents, asked of the server. `client` is the source to ask: the local
 * server by default, a workspace's gateway client when browsing for a remote one. */
export const fetchListing = (spec: ListingSpec, client: CorviClient = apiClient): Promise<Listing> =>
  client.repositories.directories(spec);
