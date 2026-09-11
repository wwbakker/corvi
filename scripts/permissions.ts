/**
 * Whether this terminal may look at, and click on, the app's own window.
 *
 *   bun run app:permissions
 *
 * Playwright can drive the page in a browser engine, which is most of what matters — but the app
 * is a native window around it, and the parts that are not the page (the title bar, the Dock
 * icon, a confirm sheet, a menu item) can only be checked by looking at the real thing. macOS
 * gates both of those behind permissions granted per application, so this reports where they
 * stand rather than failing mysteriously later.
 *
 * Screen recording gets you a screenshot; accessibility gets you clicks and window titles. What
 * they cover, in the order they are worth having:
 *
 *   - none:          the window list (size and position, no titles) — enough to prove a sheet
 *                    opened
 *   - screen:        screenshots of the app, so a layout can be looked at rather than described
 *   - accessibility: clicking buttons and reading labels, so the app can be driven end to end
 */
import { sh } from "./sh.ts";

/** The terminal this is being run from, which is what the permission is granted to — not `bun`
 * and not IWE. Reported plainly, because that is the row to look for in System Settings. */
const host = (): string => process.env.TERM_PROGRAM ?? "your terminal";

async function screenRecording(): Promise<boolean> {
  // A capture of one pixel: it succeeds when the permission is there and writes nothing when it
  // is not, which is the only reliable way to ask.
  const shot = "/tmp/iwe-permission-probe.png";
  await sh(["rm", "-f", shot]);
  await sh(["screencapture", "-x", "-R", "0,0,1,1", shot]);
  const taken = await Bun.file(shot).exists();
  await sh(["rm", "-f", shot]);
  return taken;
}

async function accessibility(): Promise<boolean> {
  // It has to be a question about another process's *interface*: listing process names is allowed
  // without the permission, and reading a window's title is not. Anything else the query trips
  // over — no front window, no such process — is not this permission, so only the refusal itself
  // counts, which macOS reports as -1719 "not allowed assistive access".
  const asked = await sh([
    "osascript",
    "-e",
    'tell application "System Events" to tell (first process whose frontmost is true) ' +
      "to get name of front window",
  ]);
  return !`${asked.stderr}${asked.stdout}`.includes("assistive access");
}

const yes = "\u001b[32m✓\u001b[0m";
const no = "\u001b[33m—\u001b[0m";

const screen = await screenRecording();
const clicks = await accessibility();

console.log(`${screen ? yes : no} screen recording   screenshots of the app's own window`);
console.log(`${clicks ? yes : no} accessibility      clicking it, and reading what its buttons say`);

if (!screen || !clicks) {
  console.log(`\nGrant them to ${host()} in System Settings → Privacy & Security:`);
  if (!screen) console.log("  Screen Recording  → add and tick it");
  if (!clicks) console.log("  Accessibility     → add and tick it");
  console.log("Then restart the terminal: both are read when a process starts.");
} else {
  console.log("\nThe app can be driven as well as looked at.");
}
