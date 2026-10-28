import { describe, expect, test } from "bun:test";
import { WINDOW_TITLE_MAX } from "@corvi/contracts/terminal";
import { mergeRecords, parseRecords, type LiveWindow, type WindowRecord } from "../apps/server/src/terminals/server/registry.ts";

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

  test("keeps a user-given title across a rebuild and a live relabel", () => {
    const previous = [record({ id: "a", label: "Action", title: "Build logs" })];
    // The live backing speaks again (a relabelled action run); the name you gave is untouched.
    const rebuilt = mergeRecords(previous, [
      { id: "a", kind: "host", panes: ["a"], label: "Action (retry)", command: "gradle build" },
    ]);
    expect(rebuilt[0]?.title).toBe("Build logs");
    expect(rebuilt[0]?.label).toBe("Action (retry)");
    // A plain rebuild keeps it too: the registry, not the shell, remembers it.
    expect(mergeRecords(rebuilt, [host("a")])[0]?.title).toBe("Build logs");
  });

  test("an empty live set empties the registry", () => {
    expect(mergeRecords([record({ id: "a", active: true })], [])).toEqual([]);
  });

  test("adopts a live pane the record does not list, so a crash mid-split is not orphaned", () => {
    const previous = [record({ id: "a", panes: ["p1", "p2"], activePane: "p2", active: true })];
    // p3 is live but unlisted: a split that saved its session but not its record. It is adopted
    // into the window whose metadata named it, rather than becoming an invisible shell.
    const merged = mergeRecords(previous, [{ id: "a", kind: "host", panes: ["p1", "p2", "p3"] }]);
    expect(merged[0]?.panes).toEqual(["p1", "p2", "p3"]);
    expect(merged[0]?.activePane).toBe("p2");
    // A pane whose session is gone is dropped; the first remaining pane is focused when the active
    // one is gone.
    const after = mergeRecords(merged, [{ id: "a", kind: "host", panes: ["p1", "p3"] }]);
    expect(after[0]?.panes).toEqual(["p1", "p3"]);
    expect(after[0]?.activePane).toBe("p1");
  });
});

describe("registry records", () => {
  test("a malformed record is dropped, not guessed at", () => {
    // No id, no panes, an empty panes list, null and a primitive: each is dropped rather than
    // guessed at.
    expect(parseRecords([{ label: "no id" }, { id: "no panes" }, { id: "empty", panes: [] }, null, 3])).toEqual(
      [],
    );
    expect(parseRecords("not an array")).toEqual([]);
  });

  test("keeps a title the way the writer stores it — trimmed and capped — and drops a blank one", () => {
    const parse = (title: unknown): string | undefined =>
      parseRecords([{ id: "a", panes: ["a"], title }])[0]?.title;
    expect(parse("  Build logs  ")).toBe("Build logs");
    // A hand-edited file cannot smuggle in a name the field does not offer.
    expect(parse("x".repeat(WINDOW_TITLE_MAX + 10))).toBe("x".repeat(WINDOW_TITLE_MAX));
    expect(parse("   ")).toBeUndefined();
    expect(parse(7)).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });
});
