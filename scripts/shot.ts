/** Screenshots the running app so the UI can be inspected without a human describing it.
 *
 *   bun run shot                    # Chromium, against http://127.0.0.1:4000
 *   CORVI_HEADED=1 bun run shot     # with a window, when captures come out stale
 *   CORVI_ENGINE=webkit bun run shot
 *   CORVI_URL=... bun run shot
 *
 * Writes to shots/. Requires `bunx playwright install chromium` once (webkit too, only for the
 * other-engine run).
 *
 * Chromium by default because that is what the app is: the window is Electron, and Electron is
 * Chromium (docs/manual/interface.md). WebKit is a variable away for checking the page in
 * another browser — the page is a web page first, and browsers remain a first-class view.
 *
 * A window that other windows cover stops painting, and the capture then serves a frame from
 * whenever it last did — a shot that disagrees with the page. The launch flags keep it
 * compositing anyway; `CORVI_HEADED=1` opens it as a real window for the cases that still come
 * out stale. Read a shot against what you expect to see before trusting it. */
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { env } from "@corvi/configuration/node";

const url = process.env[env("URL")] ?? "http://127.0.0.1:4000";

/** The engine of the app's own window: Chromium, via Electron. `CORVI_ENGINE` overrides it. */
const windowEngine = (): "webkit" | "chromium" => "chromium";

const engineName = process.env[env("ENGINE")] ?? windowEngine();
const engine = engineName === "webkit" ? webkit : chromium;
await mkdir("shots", { recursive: true });

const browser = await engine.launch({
  headless: !process.env[env("HEADED")],
  args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
console.log(`${engineName} against ${url}`);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

const shot = async (name: string): Promise<void> => {
  // Bring the window up and let the last change settle: a capture taken mid-update shows the
  // form of a moment ago.
  await page.bringToFront();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `shots/${name}.png`, fullPage: true });
  console.log(`shots/${name}.png`);
};

await page.goto(url, { waitUntil: "networkidle" });
await shot("1-home");

await page.locator(".sidebar .ideas-row .create").click();
// An instance with an issue integration opens the wizard on it; one without goes straight to
// the idea. The shots below cover the shared steps either way, so the tool works against any
// configuration — a development instance, or an isolated one with fixture repositories.
const issueRows = page.locator(".table tbody tr:not(.group)");
await Promise.race([
  page.waitForSelector(".table tbody tr", { timeout: 30_000 }).catch(() => {}),
  page.waitForSelector(".steps button.step", { timeout: 30_000 }).catch(() => {}),
]);
if (await issueRows.first().isVisible().catch(() => false)) {
  await shot("2-wizard-jira");

  // The create-issue dialog, then dismissed again.
  const createIssue = page.getByRole("button", { name: "Create new issue" });
  if (await createIssue.isVisible().catch(() => false)) {
    await createIssue.click();
    await page.waitForTimeout(200);
    await shot("2b-new-issue-dialog");
    await page.locator("dialog").getByRole("button", { name: "Cancel" }).click();
  }

  // Pick the first issue, then walk the remaining steps.
  await issueRows.first().click();
}
await page.locator(".steps button.step", { hasText: "Idea" }).click();
await shot("3-wizard-change");
await page.locator(".steps button.step", { hasText: "Repositories" }).click();
// Tick the first repository, so the shot shows the browser in use. Rows settle when the listing
// arrives — the empty hint is not a row — and the first row is not always a repository: a
// starting directory of plain directories needs one step in first.
const rows = page.locator(".entries li:not(.hint)");
const add = page.locator(".entries button:enabled", { hasText: /^Add$/ }).first();
await rows.first().waitFor();
if (await add.isVisible().catch(() => false)) {
  await add.click();
} else {
  await page.locator(".entries button.dir").first().click();
  await rows.first().waitFor();
  await add.click();
}
// The branch lists arrive with the row; the shot should show them.
await page.waitForTimeout(300);
console.log("DEBUG", JSON.stringify(await page.evaluate(() => ({ active: document.querySelector(".steps button.step.active")?.textContent, hasBrowser: Boolean(document.querySelector(".browser")) }))));
await shot("4-wizard-repos");

if (errors.length) console.log("console errors:\n" + errors.join("\n"));
await browser.close();
