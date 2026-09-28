/** One running server's self-description, written to the state directory at startup and removed
 * again on a clean shutdown.
 *
 * A file per port, beside the pid-files the desktop window writes: the port is in the name, so a
 * dev server and the app cannot overwrite each other. It is a discovery *hint* and never trusted
 * — a caller probes the URL before using it — which is why it carries the listening URL rather
 * than enough information to reconstruct it.
 */
import { Schema } from "effect"

export const InstanceRecordSchema = Schema.Struct({
  url: Schema.String,
  port: Schema.Number,
  pid: Schema.Number,
  startedAt: Schema.String,
})
export type InstanceRecord = typeof InstanceRecordSchema.Type
