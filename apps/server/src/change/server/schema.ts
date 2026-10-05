import { Schema } from "effect";
import { ChangeWireSchema } from "@corvi/contracts/api";
import type { Change as ChangeShape } from "@corvi/changes/record";

/**
 * The change.json on disk — the JSON boundary of a change (apps/server/src/change/server/store.ts).
 *
 * The schema is the canonical wire contract (`@corvi/contracts/api`), so the record the store
 * writes and the record the routes serve are described once. Decode keeps unknown keys (the
 * shared decode-then-merge at the decode site, `@corvi/contracts/body`'s `decodePreserving`): a
 * change.json carries whatever the code that wrote it put there, and rewriting it must not drop
 * fields a newer or older Corvi version added.
 */
export const Change = ChangeWireSchema;

// The schema and the hand-written type must not drift: this line fails to compile if the
// schema stops describing exactly the Change every module reads.
const _changeMatchesType: Schema.Schema<ChangeShape> = Change;
