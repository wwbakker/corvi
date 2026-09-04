/*
 * Clicks the app's own window, by the names a screen reader would read out.
 *
 *   bun run app:drive "PROJ-123" "Actions" "Cancel change" OK
 *
 * Each argument is a button to find and click, in order; `OK` and `Cancel` also match the buttons
 * on a sheet. What it prints is what it found, so a step that matched nothing is visible rather
 * than silent.
 *
 * This is for the parts that are not the page — the sheets the app draws because a WKWebView
 * draws none, the menu bar, the Dock. Playwright drives the page far better; it cannot see any of
 * that. Needs Accessibility permission for the terminal it runs from: `bun run app:permissions`.
 *
 * JXA rather than AppleScript because the tree is deep and recursive, and AppleScript's
 * `entire contents` trips over elements it cannot coerce.
 */
const APP = "Integrated Work Environment";

const se = Application("System Events");
const app = se.applicationProcesses[APP];

/** Depth-first for a button whose name matches. The web area nests about ten levels down. */
function find(element, wanted, depth = 0) {
  if (depth > 14) return null;
  let kids;
  try {
    kids = element.uiElements();
  } catch (e) {
    return null; // an element that does not answer is one to walk past
  }
  // By index, with each access guarded: JXA hands back lazy references, and the page under them
  // is re-rendering — a menu opening, an event arriving — so an element that existed when the
  // list was made can be gone by the time it is read. That arrives as "Invalid index" from the
  // middle of a walk, which was every second run of this.
  let count = 0;
  try {
    count = kids.length;
  } catch (e) {
    return null;
  }
  for (let i = 0; i < count; i++) {
    let kid = null;
    let name = null;
    let role = null;
    try {
      kid = kids[i];
      name = kid.name();
    } catch (e) {}
    try {
      role = kid.role();
    } catch (e) {}
    if (!kid) continue;
    if (role === "AXButton" && name && wanted.test(name)) return kid;
    const deeper = find(kid, wanted, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/** Try for five seconds: a click opens something, and what it opens arrives when it arrives. */
function click(label) {
  const wanted = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  for (let i = 0; i < 20; i++) {
    let button = null;
    try {
      button = find(app.windows[0], wanted);
    } catch (e) {
      // No window yet: the app was just launched, or is showing only a sheet.
    }
    if (button) {
      // Named before it is clicked: a menu item that has just been chosen no longer exists, and
      // asking it what it was called throws "Invalid index" — which reads exactly like the click
      // having failed, when it is the click having worked.
      let name = label;
      try {
        name = button.name();
      } catch (e) {}
      button.click();
      return `clicked: ${name}`;
    }
    // A sheet is not inside the window's own tree, and asking for one that is not there throws
    // rather than answering "none".
    try {
      const found = app.windows[0].sheets[0].buttons.whose({ name: label });
      if (found.length > 0) {
        found[0].click();
        return `clicked on the sheet: ${label}`;
      }
    } catch (e) {}
    delay(0.25);
  }
  return `NOT FOUND: ${label}`;
}

function run(labels) {
  if (!labels.length) {
    return "usage: bun run app:drive <button name> [<button name> ...]";
  }
  app.frontmost = true;
  delay(0.5);
  // A sheet is modal: while one is up, nothing in the window behind it can be found, and every
  // step reports "NOT FOUND" for a reason that has nothing to do with what was asked for.
  try {
    if (app.windows[0].sheets.length > 0) {
      return `a sheet is already open: "${app.windows[0].sheets[0].staticTexts[0].value()}" — answer it first`;
    }
  } catch (e) {}
  const done = [];
  for (const label of labels) {
    try {
      done.push(click(label));
    } catch (e) {
      // Reported with everything that worked, rather than as a bare error code: a step that
      // failed after three that worked is a different problem from one that never started.
      done.push(`FAILED on ${label}: ${e.message}`);
      break;
    }
    delay(1);
  }
  return done.join("\n");
}
