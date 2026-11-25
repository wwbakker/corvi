import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Browser } from "playwright";

import {
  budget,
  closePages,
  openBrowser,
  reservePort,
  startTestServer,
  stopTestServer,
  testTempDir,
  until,
} from "./helpers.ts";
import { startFakeRemote } from "./fakeRemote.ts";

/**
 * A file dropped into a remote workspace's terminal: the page uploads it through the local
 * server's gateway to the remote, and pastes the path the remote answered — the one the program on
 * the remote can open — rather than anything on this machine.
 */
let browser: Browser;
const usable = await openBrowser((opened) => {
  browser = opened;
});

const REMOTE = "REMOTE-ATTACH";

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "terminal-remote-attach");
  await browser?.close();
}, budget(30_000));

test.skipIf(!usable)(
  "a file dropped into a remote terminal is stored on the remote and its remote path pasted",
  async () => {
    const tmp = await testTempDir("terminal-remote-attach");
    const port = await reservePort();
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        workspaces: [
          { id: "local", name: "Local" },
          {
            id: "remote-client",
            name: "Remote client",
            remote: { url: `http://127.0.0.1:${port}`, workspace: "client", token: "remote-token" },
          },
        ],
      }),
    );
    const { server, url } = await startTestServer(tmp, { env: { CORVI_PORT: "0" } });
    const remote = await startFakeRemote(port, { changeId: REMOTE, terminal: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${url}/changes/${REMOTE}/terminals?source=remote-client`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(60_000) });
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File(["REMOTE-BYTES"], "shot one.png"));
        const target = document.querySelector(".terminal-screen")!;
        for (const type of ["dragenter", "dragover", "drop"]) {
          target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
        }
      });
      const pasted = `'/srv/remote/${REMOTE}/.attachments/shot one.png' `;
      await until(async () => remote.received.join("").includes(pasted), true, budget(30_000));
      expect(remote.uploads).toEqual([{ name: "shot one.png", body: "REMOTE-BYTES" }]);
      expect(remote.received.join("")).toContain(pasted);
    } finally {
      await page.close();
      remote.close();
      await stopTestServer(server, tmp);
      await rm(tmp, { recursive: true, force: true });
    }
  },
  budget(180_000),
);
