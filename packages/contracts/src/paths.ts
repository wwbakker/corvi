/** Shared path values for boundaries that must not import Node. */
import { Schema } from "effect"

export const AbsolutePath = Schema.String.pipe(Schema.brand("corvi/AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

/** Trailing `/` or `\` removed, in one pass. The regex equivalent — a separator class with a
 * `+` quantifier, anchored at the end — backtracks quadratically on a separator-heavy tail: the
 * input a boundary sees when a repository path is hostile. This loop cannot run longer than
 * the string. */
export const trimTrailingSeparators = (text: string): string => {
  let end = text.length
  while (end > 0 && (text.charCodeAt(end - 1) === 47 || text.charCodeAt(end - 1) === 92)) {
    end -= 1
  }
  return text.slice(0, end)
}

/** Leading `/` or `\` removed, in one pass, for the same reason. */
export const trimLeadingSeparators = (text: string): string => {
  let start = 0
  while (start < text.length && (text.charCodeAt(start) === 47 || text.charCodeAt(start) === 92)) {
    start += 1
  }
  return text.slice(start)
}

/** The last `/`- or `\`-separated component of a path, trailing separators ignored: the whole
 * trailing-trimmed path when it names no component. Hand-written rather than `node:path`, so
 * every package that takes a file name from a repository path stays free of Node built-ins. */
export const baseName = (path: string): string => {
  const trimmed = trimTrailingSeparators(path)
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}
