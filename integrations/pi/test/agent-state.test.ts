import { test, expect } from "bun:test";
import { firstSentence, textOf } from "../src/agent-state.ts";

/**
 * The pi reporter's pure half: what the notification says after the session's name, and which
 * text it reads from pi's messages. The rest is tmux options and pi events.
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
