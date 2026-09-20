/** Design prototype: absolute path values shared by the capabilities. */
import { Schema } from "effect"

export const AbsolutePath = Schema.String.pipe(Schema.brand("corvi/AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

/** A plain POSIX join is enough for the prototype; the adapter owns real path handling. */
export const join = (left: string, right: string): string =>
  `${left.replace(/[\\/]+$/, "")}/${right.replace(/^[\\/]+/, "")}`
