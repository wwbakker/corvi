/** Shared path values for boundaries that must not import Node. */
import { Schema } from "effect"

export const AbsolutePath = Schema.String.pipe(Schema.brand("corvi/AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type
