/** The documentation the editor's panel shows, pinned to the vocabulary it documents
 * (`../src/fields.ts` → `../src/model.ts`). The fields themselves are pinned at compile time —
 * `fields.ts` keys its entries by `Action`'s fields, so a vocabulary change without a docs
 * change does not build. What cannot be pinned by type is pinned here, against the parser's
 * behavior: every documented field is one `parseActionFile` validates, the documented values
 * are the ones it accepts and no others, and the documented defaults are what it returns. A
 * vocabulary change without a docs change fails — which is the point, since the panel is how
 * users learn the vocabulary. */
import { expect, test } from "bun:test";
import { Either } from "effect";

import { actionFieldDocs, type ActionFieldDoc } from "../src/fields.ts";
import { parseActionFile, type Action } from "../src/model.ts";

const promptFile = (frontmatter: string): string => `---\n${frontmatter}\n---\nDo the thing.\n`;

const reasonsOf = (text: string): readonly string[] => {
  const parsed = parseActionFile(text);
  if (Either.isRight(parsed)) throw new Error("expected the file to be refused");
  return parsed.left.reasons;
};

const parsedRight = (text: string): Action => {
  const parsed = parseActionFile(text);
  if (Either.isLeft(parsed)) throw new Error(`expected the file to parse: ${parsed.left.reasons}`);
  return parsed.right;
};

const docsOf = (name: string): ActionFieldDoc => {
  const found = actionFieldDocs.find((doc) => doc.name === name);
  if (found === undefined) throw new Error(`undocumented field: ${name}`);
  return found;
};

/** The base a per-field probe stands on: valid in every other field. */
const base = "label: A\nkind: prompt";

test("every documented field is one the parser validates, by name", () => {
  // A value of the wrong type for each field, in a file valid in every other one.
  const probes: Record<string, string> = {
    label: "kind: prompt\nlabel: 3",
    kind: "label: A\nkind: 3",
    target: `${base}\ntarget: 3`,
    start: `${base}\nstart: 3`,
    submit: `${base}\nsubmit: 3`,
    phases: `${base}\nphases: 3`,
    notify: "label: A\nkind: command\nnotify: 3",
    keepOpen: "label: A\nkind: command\nkeepOpen: 3",
  };
  for (const doc of actionFieldDocs) {
    if (doc.name === "body") continue;
    const probe = probes[doc.name];
    if (probe === undefined) throw new Error(`no probe for ${doc.name} — the vocabulary grew?`);
    const reasons = reasonsOf(promptFile(probe));
    expect(
      reasons.some((reason) => reason.startsWith(`${doc.name}:`)),
      `refusing ${doc.name} must say ${doc.name}: — got ${JSON.stringify(reasons)}`,
    ).toBe(true);
  }
});

test("the documented values are the ones the parser accepts, and no others", () => {
  for (const name of ["kind", "target", "submit", "phases", "notify", "keepOpen"]) {
    const { values } = docsOf(name);
    if (values.kind !== "choices") throw new Error(`${name} should offer choices`);
    for (const choice of values.choices) {
      // Each choice stands in a file valid for it: a prompt for kind/submit/target, a command
      // for notify/keepOpen (which only a command may carry), and target: new takes a start.
      const line = `${name}: ${name === "phases" ? `[${choice}]` : choice}`;
      const lines =
        name === "notify" || name === "keepOpen"
          ? ["label: A", "kind: command", line]
          : [
              "label: A",
              ...(name === "kind" ? [line] : ["kind: prompt", line]),
              ...(name === "target" && choice === "new" ? ["start: pi"] : []),
            ];
      expect(
        Either.isRight(parseActionFile(promptFile(lines.join("\n")))),
        `${name}: ${choice} must parse`,
      ).toBe(true);
    }
    // And the list is exhaustive: one value past its end is refused.
    const lines =
      name === "notify" || name === "keepOpen"
        ? ["label: A", "kind: command", `${name}: soon`]
        : ["label: A", ...(name === "kind" ? [] : ["kind: prompt"]), `${name}: ${name === "phases" ? "[Soon]" : "soon"}`];
    expect(
      reasonsOf(promptFile(lines.join("\n"))).some((reason) => reason.startsWith(`${name}:`)),
    ).toBe(true);
  }
});

test("the documented defaults are what an absent field means", () => {
  const plain = parsedRight(promptFile("label: A\nkind: prompt"));
  expect(docsOf("target").defaultValue).toBe(plain.target);
  expect(docsOf("submit").defaultValue).toBe(String(plain.submit));
  // A prompt into an agent window is the one place `start` defaults.
  const intoAgent = parsedRight(promptFile("label: A\nkind: prompt\ntarget: agent"));
  expect(intoAgent.start).toBe("pi");
  expect(docsOf("start").defaultValue).toContain("pi");
  // An absent `phases` means every phase, and `notify`/`keepOpen` mean off.
  expect(plain.phases).toBeUndefined();
  expect(docsOf("phases").defaultValue).toBe("every phase");
  expect(docsOf("notify").defaultValue).toBe(String(plain.notify));
  expect(docsOf("keepOpen").defaultValue).toBe(String(plain.keepOpen));
});
