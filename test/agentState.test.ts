import { test, expect } from "bun:test";
import { firstSentence, textOf } from "../extensions/agent-state.ts";

/**
 * The pi extension's half of the notification text: what the session's name is followed by.
 * Tested here because it is the one piece of the extension that is pure — the rest is tmux
 * options and pi events.
 */
test("the notification sentence is the first one, on a single line", () => {
  expect(firstSentence("I fixed the layout. Then I pushed.")).toBe("I fixed the layout.");
  expect(firstSentence("line one\n\nline two")).toBe("line one line two");
  // An answer that never ends a sentence is still said, just cut short and marked.
  const long = "a".repeat(300);
  expect(firstSentence(long)).toHaveLength(180);
  expect(firstSentence(long).endsWith("…")).toBe(true);
});

test("only an assistant's text is read, and nothing else", () => {
  expect(
    textOf({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "toolCall", name: "bash" },
      ],
    }),
  ).toBe("first second");
  expect(textOf({ role: "user", content: [{ type: "text", text: "hello" }] })).toBe("");
  expect(textOf({ role: "assistant", content: "not an array" })).toBe("");
  expect(textOf(undefined)).toBe("");
});
