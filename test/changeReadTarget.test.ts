import { expect, test } from "bun:test";

import type { RemoteAvailabilityStatusDto } from "@corvi/contracts/availability";
import { changeReadStillCurrent, type ChangeReadTarget } from "../apps/web/src/app-root/state.ts";
import type { OwnerAvailability, OwnerAvailabilityEntry } from "../apps/web/src/app-root/sourceOwner.ts";

/**
 * The change list is published per target, and a read is answered against the target it asked
 * for. A retarget or an outage while the request is in flight must drop the answer rather than
 * stamp it with whatever generation the world has by the time it lands.
 */
const available: RemoteAvailabilityStatusDto = { _tag: "available" };
const unavailable: RemoteAvailabilityStatusDto = {
  _tag: "unavailable",
  reason: { _tag: "unreachable", message: "the remote server could not be reached" },
};

const entry = (
  status: RemoteAvailabilityStatusDto = available,
  generation = "g1",
): OwnerAvailabilityEntry => ({ status, generation, revision: 1 });
const target = (over: Partial<ChangeReadTarget> = {}): ChangeReadTarget => ({
  source: "r",
  generation: "g1",
  status: "available",
  ...over,
});

test("a read's answer is published only for the target it asked for", () => {
  const sources = ["r"];
  // The same source, generation and reachability: the answer is this target's.
  expect(changeReadStillCurrent(target(), sources, { r: entry() })).toBe(true);

  // A same-id retarget while it was in flight: the old target's answer is not the new one's.
  expect(changeReadStillCurrent(target(), sources, { r: entry(available, "g2") })).toBe(false);
  // Yet a read that started under g2 and lands under g2 is published.
  expect(changeReadStillCurrent(target({ generation: "g2" }), sources, { r: entry(available, "g2") })).toBe(true);

  // The source was removed: a late answer cannot bring it back.
  expect(changeReadStillCurrent(target(), [], { r: entry() })).toBe(false);

  // A same-generation outage: the answer must not be published as fresh over the stale mark.
  expect(changeReadStillCurrent(target(), sources, { r: entry(unavailable, "g1") })).toBe(false);

  // The local source has no availability entry and is always the target it says it is.
  expect(
    changeReadStillCurrent(target({ source: "", generation: "", status: "available" }), [""], {}),
  ).toBe(true);
});
