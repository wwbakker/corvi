/** The change record's vocabulary and rules (`@corvi/changes/record`), re-exported so the
 * browser half imports one module for the record.
 *
 * The web's `Change` is the wire record plus the source that owns it: `source` is `""` for a
 * local change and the local workspace id for a remote one. It is optional so a record a route
 * returns is still assignable; the merged list (`app-root/state.ts`) tags every change, so a
 * rendered change always has it. The record's own functions take the wire shape, which this is a
 * superset of, so they accept it unchanged.
 */
export * from "@corvi/changes/record";

import type { ChangeWireDto } from "@corvi/contracts/api";

export type Change = ChangeWireDto & { readonly source?: string };
