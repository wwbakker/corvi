import { test, expect } from "bun:test";
import { firstSentence, trackAnswer } from "../src/agent-state.ts";

/**
 * The opencode reporter's pure half: the notification sentence and the shape of one answer as
 * opencode writes it (text parts accumulating over `message.part.updated` events). The rest is
 * tmux options and opencode events.
 */
test("the notification sentence is the first one, on a single line", () => {
  expect(firstSentence("I fixed the layout. Then I pushed.")).toBe("I fixed the layout.");
  expect(firstSentence("line one\n\nline two")).toBe("line one line two");
  // An answer that never ends a sentence is still said, just cut short and marked.
  const long = "a".repeat(300);
  expect(firstSentence(long)).toHaveLength(180);
  expect(firstSentence(long).endsWith("…")).toBe(true);
});

test("an answer is its text parts, joined in the order they appeared", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "first");
  answer.addPart("m1", "p2", "second");
  expect(answer.answer()).toBe("first second");
});

test("a resent part replaces itself where it stands", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "first");
  answer.addPart("m1", "p2", "second");
  answer.addPart("m1", "p1", "FIRST");
  expect(answer.answer()).toBe("FIRST second");
});

test("only the current message counts, and ignored parts say nothing", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "mine");
  answer.addPart("m2", "p2", "some other message");
  answer.addPart("m1", "p3", "hidden", true);
  expect(answer.answer()).toBe("mine");
  // A new message is a new answer; the old one is gone.
  answer.begin("m2");
  expect(answer.answer()).toBe("");
  answer.addPart("m2", "p2", "the new one");
  expect(answer.answer()).toBe("the new one");
});

test("clearing forgets even the message being written", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "half an answer");
  answer.clear();
  answer.addPart("m1", "p1", "the rest");
  expect(answer.answer()).toBe("");
});
