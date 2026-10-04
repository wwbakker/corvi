import { expect, test, mock } from "bun:test";

/**
 * The Electron host's click-back: the page's registered handler must receive the source the
 * notification carried — including when the click arrives before the page has mounted its
 * handler, which the preload's pending slot holds. `electron` is mocked; nothing else about the
 * preload is.
 */
type Open = (change: string, window: string, source?: string) => void;
type Listener = (event: unknown, change: string, window: string, source?: string) => void;

let listener: Listener | undefined;
let exposed: { onOpenWindow: (callback: Open) => void } | undefined;

mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: unknown) => {
      exposed = value as { onOpenWindow: (callback: Open) => void };
    },
  },
  ipcRenderer: {
    on: (_channel: string, callback: Listener) => {
      listener = callback;
    },
    invoke: () => Promise.resolve(undefined),
    send: () => {},
  },
}));

await import("../apps/desktop/src/electron/preload.ts");

test("a click before the page registers is held, source and all, and flushed once", () => {
  const seen: [string, string, string | undefined][] = [];
  // The main process can call back before the page's handler exists (a fresh launch, a reload).
  listener!(null, "NOTIF-1", "w-0", "remote-client");

  const open: Open = (change, window, source) => seen.push([change, window, source]);
  exposed!.onOpenWindow(open);
  expect(seen).toEqual([["NOTIF-1", "w-0", "remote-client"]]);

  // The pending slot is spent: registering again does not replay the held click.
  exposed!.onOpenWindow(open);
  expect(seen).toHaveLength(1);
});

test("a click-back carries the source the notice came from", () => {
  const seen: [string, string, string | undefined][] = [];
  exposed!.onOpenWindow((change, window, source) => seen.push([change, window, source]));

  listener!(null, "NOTIF-1", "w-1", "remote-client");
  expect(seen).toEqual([["NOTIF-1", "w-1", "remote-client"]]);

  // A local notice has no source, and still opens.
  listener!(null, "NOTIF-1", "w-2");
  expect(seen[1]).toEqual(["NOTIF-1", "w-2", undefined]);
});
