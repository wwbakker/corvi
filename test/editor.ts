import type { Locator } from "playwright";

/**
 * Driving the Markdown source editor (`apps/web/src/editor/client/MarkdownEditor.tsx`) through a
 * page: what it shows and how a person types into it. CodeMirror renders the visible lines and
 * re-measures after layout, so a read waits for the rendered text to settle — a test asserts
 * what a person would see, characters and all.
 */

/** The editor's text as shown — the document's lines, joined as the document joins them — or ""
 * while the placeholder stands in for an empty document. */
export const editorText = async (editor: Locator): Promise<string> => {
  const read = (): Promise<string> =>
    editor.evaluate((el) =>
      el.querySelector(".cm-placeholder")
        ? ""
        : [...el.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "").join("\n"),
    );
  let text = await read();
  for (let attempt = 0; attempt < 20; attempt++) {
    await editor.page().waitForTimeout(50);
    const next = await read();
    if (next === text) return next;
    text = next;
  }
  return text;
};

/** Replace the editor's text the way a person would: select everything, then type over it. */
export const fillEditor = async (editor: Locator, text: string): Promise<void> => {
  await editor.locator(".cm-content").click();
  await editor.page().keyboard.press("ControlOrMeta+a");
  await editor.page().keyboard.type(text);
};
