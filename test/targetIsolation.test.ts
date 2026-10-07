import { expect, test } from "bun:test";

import type { FetchLike } from "@corvi/client";
import { ChangeId } from "@corvi/contracts/changes";
import type { RemoteAvailabilitySnapshotDto } from "@corvi/contracts/availability";
import { makeSourceOwner } from "../apps/web/src/app-root/sourceOwner.ts";
import { makeWindowsStore } from "../apps/web/src/app-root/windowState.ts";

/**
 * The seam between the availability owner and the window store. The store's `reconfigure` runs
 * from a React effect, so it can lag the owner: a queued action that captured the old target must
 * be refused by the owner itself (the capability it acquires is bound to that target), not by the
 * store's bookkeeping and not by waiting for a render.
 */
const until = async <T>(read: () => T | Promise<T>, want: T, ms = 1000): Promise<T> => {
  const deadline = Date.now() + ms;
  let value = await read();
  while (value !== want && Date.now() < deadline) {
    await Bun.sleep(5);
    value = await read();
  }
  return value;
};

const snapshot = (generation: string, revision: number): RemoteAvailabilitySnapshotDto => ({
  instance: "i1",
  revision,
  availability: [{ source: "r", status: { _tag: "available" }, generation, revision }],
});

test("a window action queued before a retarget is refused by the owner, not sent to the new target", async () => {
  let fetches = 0;
  const fetchImpl: FetchLike = async () => {
    fetches += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const owner = makeSourceOwner({
    local: {
      availability: async () => snapshot("g1", 1),
      retry: async () => snapshot("g1", 1),
    },
    baseUrlOf: (sourceId) => (sourceId === "" ? "" : `/remote/${sourceId}`),
    fetch: fetchImpl,
  });
  owner.refresh();
  await until(() => owner.availability().entries.r?.generation, "g1");

  const store = makeWindowsStore({
    list: (sourceId, generation) => owner.clientForGeneration(sourceId, generation).terminals.list(),
    act: (sourceId, generation, changeId, action) =>
      owner.clientForGeneration(sourceId, generation).terminals.windowAction(ChangeId.make(changeId), action),
  });
  store.setSources(["r"]);
  store.reconfigure("r", "g1", true);
  await until(() => store.snapshot().bySource.r?.fresh, true);

  // The owner retargets. The store has not been reconfigured yet — its facts object still looks
  // current, which is exactly the window this guards.
  owner.applyEvent(JSON.stringify(snapshot("g2", 2)));
  await until(() => owner.availability().entries.r?.generation, "g2");

  const before = fetches;
  await store.select("r", "C1", 0);
  await Bun.sleep(10);

  // The queued action acquired the g1 capability: the owner refuses it as stale and no request to
  // the new target leaves the browser. The store records the refusal rather than a selection.
  expect(fetches).toBe(before);
  expect(store.snapshot().bySource.r?.byChange["C1"]).toBeUndefined();
  expect(store.snapshot().errors.r?.["C1"] ?? "").toContain("changed");

  // Once the page's own reconfigure catches up, an action for the new target does send.
  store.reconfigure("r", "g2", true);
  await Bun.sleep(10);
  const after = fetches;
  await store.select("r", "C1", 0);
  await Bun.sleep(10);
  expect(fetches).toBeGreaterThan(after);
});
