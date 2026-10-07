/** The event vocabulary shared by the server's bus, the remote-event fan-in, and the page.
 *
 * Local events keep their own names on the wire (`changes`, `windows`, `notify`, `update`). A
 * remote workspace's events are multiplexed onto the same `/api/events` stream under one extra
 * name, `source`, whose payload is this envelope: which workspace it came from, the remote's own
 * event name, and its data. The page (2.4) listens for `source` and routes by the envelope, so
 * the local stream's shape is unchanged.
 */
import { Schema } from "effect"

/** One event name a Corvi server broadcasts. */
export const EventNameSchema = Schema.Literals(["changes", "windows", "notify", "update", "power"])
export type EventNameDto = typeof EventNameSchema.Type

/** A remote workspace's event as the local page receives it. */
export const SourceEventSchema = Schema.Struct({
  /** The local workspace id the event came from. */
  source: Schema.String,
  event: EventNameSchema,
  /** The remote event's payload (empty for the state events). */
  data: Schema.String,
})
export type SourceEventDto = typeof SourceEventSchema.Type
