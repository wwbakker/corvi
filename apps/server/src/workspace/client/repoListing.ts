import { directoryListingQuery, type DirectoryListingSpec } from "@corvi/client";
import { apiClient, type Listing } from "../../app-root/api.ts";

/** What a listing request says: where to list, which context's start directory to use when it
 * names none, and whether dot-directories are wanted. */
export type ListingSpec = DirectoryListingSpec;

/** The query the server reads, built once so the repository browser and the settings picker
 * cannot ask the same question differently. */
export const listingQuery = directoryListingQuery;

/** One directory's contents, asked of the server. */
export const fetchListing = (spec: ListingSpec): Promise<Listing> =>
  apiClient.directories(spec);
