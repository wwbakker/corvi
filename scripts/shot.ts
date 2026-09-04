/** Screenshots the running app so the UI can be inspected without a human describing it.
 *
 *   bun run shot                    # WebKit, against http://127.0.0.1:4000
 *   IWE_ENGINE=chromium bun run shot
 *   IWE_URL=... bun run shot
 *
 * Writes to shots/. Requires `bunx playwright install webkit chromium` once.
 *
 * WebKit by default because that is what the app is: the macOS window is a WKWebView, and both
 * of the bugs that made it as far as being reported were things Chrome does and WebKit does not.
 * Chromium is a variable away for when the difference is what you are looking at. */
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const url = process.env.IWE_URL ?? "http://127.0.0.1:4000";
const engine = process.env.IWE_ENGINE === "chromium" ? chromium : webkit;
await mkdir("shots", { recursive: true });

const browser = await engine.launch();
console.log(`${process.env.IWE_ENGINE ?? "webkit"} against ${url}`);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

const shot = async (name: string): Promise<void> => {
  await page.screenshot({ path: `shots/${name}.png`, fullPage: true });
  console.log(`shots/${name}.png`);
};

await page.goto(url, { waitUntil: "networkidle" });
await shot("1-home");

await page.getByRole("button", { name: "New change" }).click();
await page.waitForSelector(".table tbody tr", { timeout: 30_000 }).catch(() => {});
await shot("2-wizard-jira");

// The create-issue dialog, then dismissed again.
await page.getByRole("button", { name: "Create new issue" }).click();
await page.waitForTimeout(200);
await shot("2b-new-issue-dialog");
await page.locator("dialog").getByRole("button", { name: "Cancel" }).click();

// Pick the first issue, then walk the remaining steps.
await page.locator(".table tbody tr:not(.group)").first().click();
await page.getByRole("button", { name: "2. Change" }).click();
await shot("3-wizard-change");
await page.getByRole("button", { name: "3. Repositories" }).click();
await page.waitForSelector(".entries li");
// Step into a directory and tick a repository, so the shot shows the browser in use.
await page.locator(".entries button.dir").first().click();
await page.waitForSelector(".entries li button.dir");
await page.getByRole("button", { name: "Add", exact: true }).first().click();
await shot("4-wizard-repos");

if (errors.length) console.log("console errors:\n" + errors.join("\n"));
await browser.close();
