/** Screenshots the running app so the UI can be inspected without a human describing it.
 *
 *   bun run shot                    # Chromium, against http://127.0.0.1:4000
 *   CORVI_ENGINE=webkit bun run shot
 *   CORVI_URL=... bun run shot
 *
 * Writes to shots/. Requires `bunx playwright install chromium` once (webkit too, only for the
 * other-engine run).
 *
 * Chromium by default because that is what the app is: the window is Electron, and Electron is
 * Chromium (docs/manual/interface.md). WebKit is a variable away for checking the page in
 * another browser — the page is a web page first, and browsers remain a first-class view. */
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { env } from "../src/capabilities/identity.ts";

const url = process.env[env("URL")] ?? "http://127.0.0.1:4000";

/** The engine of the app's own window: Chromium, via Electron. `CORVI_ENGINE` overrides it. */
const windowEngine = (): "webkit" | "chromium" => "chromium";

const engineName = process.env[env("ENGINE")] ?? windowEngine();
const engine = engineName === "webkit" ? webkit : chromium;
await mkdir("shots", { recursive: true });

const browser = await engine.launch();
console.log(`${engineName} against ${url}`);
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

await page.locator(".sidebar .ideas-row .create").click();
await page.waitForSelector(".table tbody tr", { timeout: 30_000 }).catch(() => {});
await shot("2-wizard-jira");

// The create-issue dialog, then dismissed again.
await page.getByRole("button", { name: "Create new issue" }).click();
await page.waitForTimeout(200);
await shot("2b-new-issue-dialog");
await page.locator("dialog").getByRole("button", { name: "Cancel" }).click();

// Pick the first issue, then walk the remaining steps.
await page.locator(".table tbody tr:not(.group)").first().click();
await page.locator(".steps button.step", { hasText: "Idea" }).click();
await shot("3-wizard-change");
await page.locator(".steps button.step", { hasText: "Repositories" }).click();
await page.waitForSelector(".entries li");
// Step into a directory and tick a repository, so the shot shows the browser in use.
await page.locator(".entries button.dir").first().click();
await page.waitForSelector(".entries li button.dir");
await page.getByRole("button", { name: "Add", exact: true }).first().click();
await shot("4-wizard-repos");

if (errors.length) console.log("console errors:\n" + errors.join("\n"));
await browser.close();
