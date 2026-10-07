/** The remote workspaces' transient reachability, as the local server observes it.
 *
 * Availability is advisory and server-owned: the local server holds one health stream per remote
 * workspace and publishes its state. The browser keeps a snapshot and applies updates by
 * `(instance, revision)`, so it can recover after a server restart (a new instance, revisions
 * from zero) without applying an older server's answers. This is not durable history and it is
 * never a claim about the remote's shells: a workspace that cannot be reached is not a workspace
 * whose terminals died.
 */
import { Schema } from "effect"

/** Why a remote workspace is not reachable. Fixed, server-authored kinds — never a raw remote
 * error body, a credential, or a URL that carries one. */
export const RemoteAvailabilityReasonSchema = Schema.Union([
  Schema.TaggedStruct("unreachable", { message: Schema.String }),
  Schema.TaggedStruct("authentication", { message: Schema.String }),
  Schema.TaggedStruct("configuration", { message: Schema.String }),
  Schema.TaggedStruct("stalled", { message: Schema.String }),
])
export type RemoteAvailabilityReasonDto = typeof RemoteAvailabilityReasonSchema.Type

/** One remote workspace's reachability. The union makes invalid combinations unrepresentable:
 * `checking` and `available` carry no reason, and `unavailable` always names one. */
export const RemoteAvailabilityStatusSchema = Schema.Union([
  Schema.TaggedStruct("checking", {}),
  Schema.TaggedStruct("available", {}),
  Schema.TaggedStruct("unavailable", { reason: RemoteAvailabilityReasonSchema }),
])
export type RemoteAvailabilityStatusDto = typeof RemoteAvailabilityStatusSchema.Type

/** One source's availability, with the opaque identity of the target it describes.
 *
 * `generation` is random and minted whenever the configured target (`url`, `workspace` or
 * `token`) changes: a consumer keys cached answers by `(source, generation)` so a retargeted
 * workspace cannot reuse the old target's data. It is deliberately **not** derived from the
 * target or the credential.
 *
 * `revision` increases with each publish for that target and is only meaningful within one
 * server `instance`.
 *
 * A consumer that sees a target's `generation` change treats every answer it holds for the old
 * generation as retired: it cancels reads still in flight and never replays a write for the old
 * target. Availability never proves a shell died, so losing it is not a reason to destroy
 * anything. */
/** A monotonic publish counter: a whole number, never negative. */
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

export const RemoteAvailabilitySchema = Schema.Struct({
  source: Schema.String,
  status: RemoteAvailabilityStatusSchema,
  generation: Schema.String,
  revision: Revision,
})
export type RemoteAvailabilityDto = typeof RemoteAvailabilitySchema.Type

/** The whole map as a route or an event carries it.
 *
 * `instance` is random per server process, and `revision` is monotonic within it. A consumer
 * keeps the instance it learned from an authoritative read — a fresh page, or the snapshot it
 * fetches after reconnecting — and applies events only when their instance matches and their
 * revision is strictly newer. An event naming an instance the consumer has not established must
 * not be accepted as a new epoch: it is an old server's frame, so the consumer re-fetches the
 * snapshot and lets that answer decide. Ordering is these two fields, never arrival order. */
export const RemoteAvailabilitySnapshotSchema = Schema.Struct({
  instance: Schema.String,
  revision: Revision,
  availability: Schema.mutable(Schema.Array(RemoteAvailabilitySchema)),
})
export type RemoteAvailabilitySnapshotDto = typeof RemoteAvailabilitySnapshotSchema.Type
