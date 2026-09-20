/** Design prototype: the canonical path brand plus the prototype's pure join. */
export { AbsolutePath } from "@corvi/contracts/paths"

/** A plain POSIX join is enough for the prototype; the adapter owns real path handling. */
export const join = (left: string, right: string): string =>
  `${left.replace(/[\\/]+$/, "")}/${right.replace(/^[\\/]+/, "")}`
