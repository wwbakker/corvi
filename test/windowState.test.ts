import { expect, test } from "bun:test";

import type { TerminalWindow } from "@corvi/contracts/terminal";
import { makeWindowsStore, type WindowsTransport } from "../apps/web/src/app-root/windowState.ts";

/**
 * The page's window store: the ordering rules that keep a slow source, a slow mutation or an
 * out-of-order response from rolling back a newer selection. These drive the store the React hook
 * uses, with a scripted transport, so a request can be completed in a chosen order rather than
 * racing a real server.
 */
const terminalWindow = (id: string, active: boolean): TerminalWindow => ({
  index: 0,
  id,
  label: id,
  detail: "",
  attention: false,
  active,
  activity: false,
  panes: [id],
  activePane: id,
});

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Let every microtask a settled transport promise queued run. */
const flush = (): Promise<void> => Bun.sleep(0);

const transport = (over: Partial<WindowsTransport> = {}): WindowsTransport => ({
  list: async () => ({}),
  act: async (_sourceId, _generation, _changeId, action) =>
    [terminalWindow(`w${action.index ?? 0}`, true)],
  ...over,
});

const activeId = (sourceId: string, changeId: string, store: ReturnType<typeof makeWindowsStore>): string | undefined =>
  store
    .snapshot()
    .bySource[sourceId]?.byChange[changeId]?.find((window) => window.active)?.id;

test("a local answer is published while a remote read is still pending", async () => {
  const remote = deferred<Record<string, TerminalWindow[]>>();
  const store = makeWindowsStore(
    transport({
      list: (sourceId) =>
        sourceId === "remote" ? remote.promise : Promise.resolve({ "LOCAL-1": [terminalWindow("w-local", true)] }),
    }),
  );
  store.setSources(["", "remote"]);
  store.reconfigure("remote", "g1", true);
  await flush();
  // The local source did not wait for the remote one.
  expect(store.snapshot().bySource[""]?.byChange["LOCAL-1"]?.[0]?.id).toBe("w-local");
  expect(store.snapshot().bySource["remote"]).toBeUndefined();

  remote.resolve({ "REMOTE-1": [terminalWindow("w-remote", true)] });
  await flush();
  expect(store.snapshot().bySource["remote"]?.byChange["REMOTE-1"]?.[0]?.id).toBe("w-remote");
});

test("a failed read keeps the last known list and stops vouching for it", async () => {
  let offline = false;
  const store = makeWindowsStore(
    transport({
      list: async () => {
        if (offline) throw new Error("offline");
        return { C: [terminalWindow("w1", true)] };
      },
    }),
  );
  store.setSources([""]);
  await flush();
  expect(store.snapshot().bySource[""]?.fresh).toBe(true);

  offline = true;
  store.refresh();
  await flush();
  // Old data is retained but not claimed live; it is not replaced by an empty list.
  expect(store.snapshot().bySource[""]?.byChange["C"]?.[0]?.id).toBe("w1");
  expect(store.snapshot().bySource[""]?.fresh).toBe(false);
});

test("conflicting selections are serialized and the last one wins", async () => {
  const calls: number[] = [];
  const store = makeWindowsStore(
    transport({
      list: async () => ({ C: [terminalWindow("w0", true), terminalWindow("w1", false)] }),
      act: async (_sourceId, _generation, _changeId, action) => {
        calls.push(action.index ?? -1);
        return [terminalWindow("w0", action.index === 0), terminalWindow("w1", action.index === 1)];
      },
    }),
  );
  store.setSources([""]);
  await flush();

  const first = store.select("", "C", 0);
  const second = store.select("", "C", 1);
  await Promise.all([first, second]);
  // The second reached the server only after the first answered, so the server saw them in order.
  expect(calls).toEqual([0, 1]);
  expect(activeId("", "C", store)).toBe("w1");
});

test("a slow earlier selection cannot overwrite the later one", async () => {
  const held = deferred<readonly TerminalWindow[]>();
  const sent: number[] = [];
  const store = makeWindowsStore(
    transport({
      list: async () => ({ C: [terminalWindow("w0", true), terminalWindow("w1", false)] }),
      act: (_sourceId, _generation, _changeId, action) => {
        sent.push(action.index ?? -1);
        if (action.index === 0) return held.promise;
        return Promise.resolve([terminalWindow("w0", false), terminalWindow("w1", true)]);
      },
    }),
  );
  store.setSources([""]);
  await flush();

  const first = store.select("", "C", 0);
  const second = store.select("", "C", 1);
  await flush();
  // The later selection is queued, not racing: only the first has been sent.
  expect(sent).toEqual([0]);

  held.resolve([terminalWindow("w0", true), terminalWindow("w1", false)]);
  await Promise.all([first, second]);
  expect(activeId("", "C", store)).toBe("w1");
});

test("a mutation on one change does not suppress another change's mutation", async () => {
  const heldA = deferred<readonly TerminalWindow[]>();
  const store = makeWindowsStore(
    transport({
      list: async () => ({}),
      act: (_sourceId, _generation, changeId) => (changeId === "A" ? heldA.promise : Promise.resolve([terminalWindow("b1", true)])),
    }),
  );
  store.setSources([""]);
  await flush();

  const a = store.select("", "A", 0);
  const b = store.select("", "B", 0);
  await b;
  // B published while A's slower write was still in flight.
  expect(store.snapshot().bySource[""]?.byChange["B"]?.[0]?.id).toBe("b1");
  expect(store.snapshot().bySource[""]?.byChange["A"]).toBeUndefined();

  heldA.resolve([terminalWindow("a1", true)]);
  await a;
  expect(store.snapshot().bySource[""]?.byChange["A"]?.[0]?.id).toBe("a1");
});

test("a read that raced a mutation is dropped and reconciled after the write settles", async () => {
  // A fake server whose reads always answer with its current active window, updated by writes.
  let serverActive = "w0";
  let reads = 0;
  const held = deferred<void>();
  const store = makeWindowsStore(
    transport({
      list: async () => {
        reads += 1;
        return { C: [terminalWindow(serverActive, true)] };
      },
      act: (_sourceId, _generation, _changeId, action) => {
        if (action.index !== 1) return Promise.resolve([terminalWindow(serverActive, true)]);
        return held.promise.then(() => {
          serverActive = "w1";
          return [terminalWindow(serverActive, true)];
        });
      },
    }),
  );
  store.setSources([""]);
  await flush();
  expect(store.snapshot().bySource[""]?.byChange["C"]?.[0]?.id).toBe("w0");

  const select = store.select("", "C", 1);
  store.refresh();
  await flush();
  // The refreshed read raced the pending write, so it was not published.
  expect(store.snapshot().bySource[""]?.byChange["C"]?.[0]?.id).toBe("w0");

  held.resolve();
  await select;
  await flush();
  // The write landed, and the dropped read was reconciled with a fresh one afterwards.
  expect(store.snapshot().bySource[""]?.byChange["C"]?.[0]?.id).toBe("w1");
  expect(reads).toBeGreaterThanOrEqual(3);
});

test("a result for a source that is gone cannot be published", async () => {
  const held = deferred<Record<string, TerminalWindow[]>>();
  const store = makeWindowsStore(transport({ list: () => held.promise }));
  store.setSources(["remote"]);
  await flush();
  store.setSources([""]);

  held.resolve({ R: [terminalWindow("r", true)] });
  await flush();
  expect(store.snapshot().bySource["remote"]).toBeUndefined();
});

test("a read in flight when its source is removed and re-added cannot republish", async () => {
  const stale = deferred<Record<string, TerminalWindow[]>>();
  let calls = 0;
  const store = makeWindowsStore(
    transport({
      list: async () => {
        calls += 1;
        if (calls === 1) return stale.promise;
        return { S: [terminalWindow("fresh", true)] };
      },
    }),
  );
  store.setSources(["remote"]);
  store.reconfigure("remote", "g1", true);
  await flush(); // read 1 is in flight
  store.setSources([]); // removed: its facts are dropped
  store.setSources(["remote"]); // re-added: a fresh facts object and a fresh read
  store.reconfigure("remote", "g1", true);
  await flush();
  expect(store.snapshot().bySource["remote"]?.byChange["S"]?.[0]?.id).toBe("fresh");

  // The old read settles with pre-removal data; it must neither publish nor schedule a read.
  stale.resolve({ S: [terminalWindow("stale", true)] });
  await flush();
  expect(store.snapshot().bySource["remote"]?.byChange["S"]?.[0]?.id).toBe("fresh");
  expect(calls).toBe(2);
});

test("a queued mutation for a removed source is not sent and never publishes", async () => {
  const held = deferred<readonly TerminalWindow[]>();
  const sent: number[] = [];
  const store = makeWindowsStore(
    transport({
      list: async () => ({ C: [terminalWindow("w0", true)] }),
      act: async (_sourceId, _generation, _changeId, action) => {
        sent.push(action.index ?? -1);
        return action.index === 0 ? held.promise : Promise.resolve([terminalWindow("w1", true)]);
      },
    }),
  );
  store.setSources(["remote"]);
  await flush();
  const first = store.select("remote", "C", 0);
  await flush(); // the first send is in flight
  const second = store.select("remote", "C", 1); // waits for its turn
  store.setSources([]); // the source is gone before the second send leaves

  held.resolve([terminalWindow("w0", true)]);
  await Promise.all([first, second]);
  // The queued send was dropped at the entry guard; the in-flight one did not publish.
  expect(sent).toEqual([0]);
  expect(store.snapshot().bySource["remote"]).toBeUndefined();
});

test("the same change id on two sources stays separate", async () => {
  const store = makeWindowsStore(
    transport({
      list: async (sourceId) => ({
        SAME: [terminalWindow(`${sourceId === "" ? "local" : sourceId}-w`, true)],
      }),
    }),
  );
  store.setSources(["", "remote"]);
  store.reconfigure("remote", "g1", true);
  await flush();
  expect(store.snapshot().bySource[""]?.byChange["SAME"]?.[0]?.id).toBe("local-w");
  expect(store.snapshot().bySource["remote"]?.byChange["SAME"]?.[0]?.id).toBe("remote-w");
});

test("an old refresh completing after a create cannot remove the new window", async () => {
  let serverWindows: TerminalWindow[] = [terminalWindow("w0", true)];
  const stale = deferred<Record<string, TerminalWindow[]>>();
  let reads = 0;
  const store = makeWindowsStore(
    transport({
      list: async () => {
        reads += 1;
        if (reads === 2) return stale.promise; // the refresh captured before the create
        return { C: serverWindows };
      },
      act: async () => {
        serverWindows = [...serverWindows, terminalWindow("w1", true)];
        return serverWindows;
      },
    }),
  );
  store.setSources([""]);
  await flush();

  store.refresh();
  await flush(); // read 2 is in flight with only w0
  await store.create("", "C");
  expect(store.snapshot().bySource[""]?.byChange["C"]?.map((window) => window.id)).toEqual(["w0", "w1"]);

  // The older refresh answers without the new window; it must not remove it.
  stale.resolve({ C: [terminalWindow("w0", true)] });
  await flush();
  expect(store.snapshot().bySource[""]?.byChange["C"]?.map((window) => window.id)).toEqual(["w0", "w1"]);
});

test("a successfully empty read is fresh; a failed first read is not", async () => {
  const answered = makeWindowsStore(transport({ list: async () => ({}) }));
  answered.setSources([""]);
  await flush();
  expect(answered.snapshot().bySource[""]?.byChange).toEqual({});
  // The source really said "none", which is not the same as knowing nothing.
  expect(answered.snapshot().bySource[""]?.fresh).toBe(true);

  const failing = makeWindowsStore(
    transport({
      list: async () => {
        throw new Error("offline");
      },
    }),
  );
  failing.setSources([""]);
  await flush();
  expect(failing.snapshot().bySource[""]?.byChange).toEqual({});
  expect(failing.snapshot().bySource[""]?.fresh).toBe(false);
});

test("repeated refreshes leave the settled selection stable", async () => {
  let serverActive = "w0";
  const store = makeWindowsStore(
    transport({
      list: async () => ({ C: [terminalWindow(serverActive, true)] }),
      act: async () => {
        serverActive = "w1";
        return [terminalWindow("w1", true)];
      },
    }),
  );
  store.setSources([""]);
  await flush();
  await store.select("", "C", 1);
  expect(activeId("", "C", store)).toBe("w1");

  for (let round = 0; round < 5; round++) {
    store.refresh();
    await flush();
  }
  expect(activeId("", "C", store)).toBe("w1");
});

test("a failed mutation is observable and a later success clears it", async () => {
  let refuse = true;
  const store = makeWindowsStore(
    transport({
      list: async () => ({ C: [terminalWindow("w0", true)] }),
      act: async () => {
        if (refuse) throw new Error("refused");
        return [terminalWindow("w0", true)];
      },
    }),
  );
  store.setSources([""]);
  await flush();

  await store.select("", "C", 0);
  expect(store.snapshot().errors[""]?.["C"]).toBe("refused");
  // The last known list is still there.
  expect(activeId("", "C", store)).toBe("w0");

  refuse = false;
  await store.select("", "C", 0);
  expect(store.snapshot().errors[""]).toBeUndefined();
});

test("a generation change drops queued sends without replaying them, and reports the uncertain one", async () => {
  const sent: number[] = [];
  const held = deferred<readonly TerminalWindow[]>();
  const store = makeWindowsStore(
    transport({
      list: async () => ({ C: [terminalWindow("w0", true)] }),
      act: async (_sourceId, _generation, _changeId, action) => {
        sent.push(action.index ?? -1);
        return action.index === 0 ? held.promise : Promise.resolve([terminalWindow("w1", true)]);
      },
    }),
  );
  store.setSources(["r"]);
  store.reconfigure("r", "g1", true);
  await flush();

  const first = store.select("r", "C", 0);
  await flush(); // the first send is in flight
  const second = store.select("r", "C", 1); // waiting for its turn
  store.reconfigure("r", "g2", true); // retarget while the first is in flight

  held.resolve([terminalWindow("w0", true)]);
  await Promise.all([first, second]);
  // The queued second never left, and the in-flight first was not replayed. Both report
  // honestly: the in-flight write's outcome is unknown, the queued one was never sent.
  expect(sent).toEqual([0]);
  expect(store.snapshot().errors.r?.["C"]).toMatch(/outcome is unknown|nothing was sent/);
});

test("an in-flight write is reported uncertain immediately when the target is retired", async () => {
  const held = deferred<readonly TerminalWindow[]>();
  const store = makeWindowsStore(
    transport({
      list: async () => ({ C: [terminalWindow("w0", true)] }),
      act: () => held.promise,
    }),
  );
  store.setSources(["r"]);
  store.reconfigure("r", "g1", true);
  await flush();
  const write = store.select("r", "C", 0);
  await flush(); // the write is in flight and may have reached the remote
  // The outage reports it at once, even though the promise never settles.
  store.reconfigure("r", "g1", false);
  expect(store.snapshot().errors.r?.["C"]).toBe("the workspace changed while saving; the outcome is unknown");
  held.resolve([terminalWindow("w0", true)]);
  await write;
});

test("a loss of reachability keeps the last known list stale and issues no read; recovery re-reads", async () => {
  let lists = 0;
  const store = makeWindowsStore(
    transport({
      list: async () => {
        lists += 1;
        return { C: [terminalWindow("w0", true)] };
      },
    }),
  );
  store.setSources(["r"]);
  // Not sendable yet: no request.
  await flush();
  expect(lists).toBe(0);

  store.reconfigure("r", "g1", true);
  await flush();
  expect(lists).toBe(1);

  store.reconfigure("r", "g1", false);
  await flush();
  expect(lists).toBe(1);
  expect(store.snapshot().bySource.r?.fresh).toBe(false);
  expect(store.snapshot().bySource.r?.byChange["C"]?.[0]?.id).toBe("w0");

  store.reconfigure("r", "g1", true);
  await flush();
  expect(lists).toBe(2);
});

test("a queued write retired by a retarget does not stamp its error on the replacement target", async () => {
  const first = deferred<readonly TerminalWindow[]>();
  const store = makeWindowsStore(
    transport({
      act: async (_sourceId, _generation, _changeId, action) => {
        // The store's `select` carries an index; the queued `focus` carries a window id.
        if ("index" in action) return first.promise;
        return [terminalWindow("w-focus", true)];
      },
    }),
  );
  store.setSources(["r"]);
  store.reconfigure("r", "g1", true);

  // The first write reaches the transport and hangs; the second queues behind it.
  void store.select("r", "C1", 0);
  await flush();
  const queued = store.focus("r", "C1", "w-focus");
  await flush();

  // The same source id is now a different target: the old target's data, queues and in-flight
  // writes are retired, and the replacement starts empty.
  store.reconfigure("r", "g2", true);
  first.resolve([terminalWindow("w-select", true)]);
  await queued;
  await flush();

  // The queued write never sent, but its "nothing was sent" belongs to the retired target: it
  // must not appear under the replacement's error map.
  expect(store.snapshot().errors.r?.["C1"] ?? "").not.toContain("nothing was sent");
  // Only the retired target's in-flight write is reported, by retireSource itself.
  expect(store.snapshot().errors.r?.["C1"]).toBe("the workspace changed while saving; the outcome is unknown");
  // The replacement target's windows are its own: the retired target's selection did not leak in.
  expect(store.snapshot().bySource.r?.byChange["C1"]).toBeUndefined();
});

test("a queued write of the same target still reports that nothing was sent after an outage", async () => {
  const first = deferred<readonly TerminalWindow[]>();
  const store = makeWindowsStore(
    transport({
      act: async (_sourceId, _generation, _changeId, action) =>
        "index" in action ? first.promise : [terminalWindow("w-focus", true)],
    }),
  );
  store.setSources(["r"]);
  store.reconfigure("r", "g1", true);

  void store.select("r", "C1", 0);
  await flush();
  const queued = store.focus("r", "C1", "w-focus");
  await flush();

  // Same target, reachability lost: the queued write is retired without ever sending.
  store.reconfigure("r", "g1", false);
  first.reject(new Error("the remote server could not be reached"));
  await queued;
  await flush();

  // The same generation still owns the message: the user learns the queued write was not sent.
  expect(store.snapshot().errors.r?.["C1"]).toBe(
    "the workspace became unavailable before saving; nothing was sent",
  );
});
