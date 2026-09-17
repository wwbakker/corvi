import { api, type Listing } from "../../app-root/api.ts";

/** What a listing request says: where to list, which context's start directory to use when it
 * names none, and whether dot-directories are wanted. */
export type ListingSpec = {
  /** An absolute directory to list; absent means the context's repositories directory. */
  path?: string;
  /** Which context's repositories directory to open on when `path` is absent. */
  workspace?: string;
  /** Include dot-directories. The server withholds them otherwise. */
  hidden?: boolean;
};

/** The query the server reads, built once so the repository browser and the settings picker
 * cannot ask the same question differently. An explicit `path` wins over `workspace`, an empty
 * one is not set, and hidden directories have to be asked for by name. */
export function listingQuery(spec: ListingSpec): string {
  const params = new URLSearchParams();
  if (spec.path) params.set("path", spec.path);
  else if (spec.workspace) params.set("workspace", spec.workspace);
  if (spec.hidden) params.set("hidden", "1");
  return params.toString();
}

/** One directory's contents, asked of the server. */
export const fetchListing = (spec: ListingSpec): Promise<Listing> => {
  const query = listingQuery(spec);
  return api<Listing>(`/repos${query ? `?${query}` : ""}`);
};
