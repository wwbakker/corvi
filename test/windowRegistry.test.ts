import { describe, expect, test } from "bun:test";
import { mergeRecords, migrateRecords, type LiveWindow, type WindowRecord } from "../apps/server/src/terminals/server/registry.ts";

/**
 * The registry's pure half: how persisted records and the live backings become one ordered list.
 * The I/O around it (`rebuild`/`save`) is exercised by the server tests; the rules that decide
 * whether a restart loses or duplicates a window live here.
 */
const record = (over: Partial<WindowRecord> & { id: string }): WindowRecord => ({
  kind: "host",
  panes: [over.id],
  activePane: over.id,
  active: false,
  activity: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const host = (id: string): LiveWindow => ({ id, kind: "host", panes: [id] });

describe("window registry merge", () => {
  test("keeps order, labels and the active flag while the backings live", () => {
    const previous = [
      record({ id: "a", label: "One", active: true }),
      record({ id: "b", label: "Two" }),
    ];
    const merged = mergeRecords(previous, [host("a"), host("b")]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(merged.map((entry) => entry.label)).toEqual(["One", "Two"]);
    expect(merged.map((entry) => entry.active)).toEqual([true, false]);
    expect(merged.map((entry) => entry.createdAt)).toEqual(previous.map((entry) => entry.createdAt));
  });

  test("drops records whose backing is gone and appends backings that are new", () => {
    const previous = [record({ id: "gone", label: "Gone" }), record({ id: "kept", label: "Kept" })];
    const merged = mergeRecords(previous, [host("kept"), host("new")]);
    expect(merged.map((entry) => entry.id)).toEqual(["kept", "new"]);
    expect(merged.find((entry) => entry.id === "kept")?.label).toBe("Kept");
    // The first surviving window is active when none was persisted as active.
    expect(merged.find((entry) => entry.id === "kept")?.active).toBe(true);
    expect(merged.find((entry) => entry.id === "new")?.active).toBe(false);
  });

  test("a rebuild with the same live set is idempotent: no loss and no duplication", () => {
    const first = mergeRecords(
      [record({ id: "a", label: "One", active: true }), record({ id: "b", label: "Two" })],
      [host("a"), host("c"), host("b")],
    );
    const second = mergeRecords(first, [host("a"), host("c"), host("b")]);
    expect(second).toEqual(first);
    expect(second).toHaveLength(3);
  });

  test("exactly one window is active when any is live", () => {
    const merged = mergeRecords([], [host("a"), host("b")]);
    expect(merged.filter((entry) => entry.active)).toHaveLength(1);
    expect(merged[0]?.active).toBe(true);
    // A persisted active flag survives a rebuild.
    const again = mergeRecords([record({ id: "b", active: true })], [host("a"), host("b")]);
    expect(again.find((entry) => entry.id === "b")?.active).toBe(true);
    expect(again.find((entry) => entry.id === "a")?.active).toBe(false);
  });

  test("an empty live set empties the registry", () => {
    expect(mergeRecords([record({ id: "a", active: true })], [])).toEqual([]);
  });

  test("the registry decides pane membership: a live session it does not list is not adopted", () => {
    const previous = [record({ id: "a", panes: ["p1", "p2"], activePane: "p2", active: true })];
    // A live session the record does not list (a split in flight, or a closing pane whose pty has
    // not exited) must not join the window.
    const merged = mergeRecords(previous, [{ id: "a", kind: "host", panes: ["p1", "p2", "p3"] }]);
    expect(merged[0]?.panes).toEqual(["p1", "p2"]);
    expect(merged[0]?.activePane).toBe("p2");
    // A pane whose session is gone is dropped; the first remaining pane is focused when the active
    // one is gone.
    const after = mergeRecords(merged, [{ id: "a", kind: "host", panes: ["p1", "p3"] }]);
    expect(after[0]?.panes).toEqual(["p1"]);
    expect(after[0]?.activePane).toBe("p1");
  });
});

describe("registry migration", () => {
  test("a record from before panes loads as a one-pane window whose id is its session id", () => {
    const migrated = migrateRecords([
      { id: "w-1", kind: "host", label: "One", active: true, activity: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.id).toBe("w-1");
    expect(migrated[0]?.panes).toEqual(["w-1"]);
    expect(migrated[0]?.activePane).toBe("w-1");
    expect(migrated[0]?.label).toBe("One");
    expect(migrated[0]?.active).toBe(true);
  });

  test("a malformed record is dropped, not guessed at", () => {
    expect(migrateRecords([{ label: "no id" }, null, 3])).toEqual([]);
    expect(migrateRecords("not an array")).toEqual([]);
  });
});
