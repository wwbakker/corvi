/**
 * What a drop or a paste puts into the terminal, decided apart from the pane that does it.
 *
 * Text is pasted as text. Files and images are uploaded to the server that runs the change's ptys
 * and their stored paths are pasted instead — what a native terminal pastes for a drop, and what
 * an agent reads as an attachment. A path is quoted for a POSIX shell only when it needs it.
 */

/** A file the page is about to upload: the name it is stored under and its bytes. */
export type TerminalUpload = {
  readonly name: string;
  readonly blob: Blob;
};

/** What a drop or a clipboard read carried, as the pane acts on it. */
export type TerminalPayload =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "files"; readonly files: readonly TerminalUpload[] }
  /** A dropped folder: it has no bytes to upload, so the drop is refused and the pane says so. */
  | { readonly kind: "folder"; readonly name: string }
  | { readonly kind: "empty" };

/** Above this many bytes in one drop or paste, the page asks before uploading. */
export const LARGE_UPLOAD_BYTES = 200 * 1024 * 1024;

/** The characters a POSIX shell word may hold without quoting. */
const PLAIN_WORD = /^[A-Za-z0-9_\-.,/:@%+=]+$/;

/** A path as one shell word: as it is when nothing in it is special, single-quoted otherwise. */
export const shellQuote = (path: string): string =>
  PLAIN_WORD.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;

/** The text a set of stored paths pastes as: one quoted word each, and a trailing space, so a
 * second drop does not run into the first — what native terminals paste for a drop. */
export const pastedPaths = (paths: readonly string[]): string =>
  paths.length === 0 ? "" : `${paths.map(shellQuote).join(" ")} `;

/** A byte count the way a question to a person says it. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

/** What a large upload asks about: what is being uploaded and how much of it. */
export type LargeUpload = {
  /** The file's name, or how many files there are. */
  readonly what: string;
  /** The total size, as a person reads it. */
  readonly size: string;
};

/** The large upload to ask about, or undefined when it is small enough to go without asking. */
export const largeUpload = (files: readonly TerminalUpload[]): LargeUpload | undefined => {
  const total = files.reduce((sum, file) => sum + file.blob.size, 0);
  if (total <= LARGE_UPLOAD_BYTES) return undefined;
  return { what: files.length === 1 ? files[0]!.name : `${files.length} files`, size: formatBytes(total) };
};

/** The extension a clipboard item's MIME type is stored with. */
const extensionOf = (type: string): string => {
  const subtype = type.split("/")[1]?.split(/[;+]/)[0]?.toLowerCase() ?? "";
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg") return "svg";
  if (subtype === "plain") return "txt";
  return /^[a-z0-9-]{1,10}$/.test(subtype) ? subtype : "bin";
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** The name of a clipboard item that has none (a screenshot): `paste-20261125-183042.png`. */
export const clipboardFileName = (type: string, at: Date): string =>
  `paste-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}` +
  `${pad(at.getMinutes())}${pad(at.getSeconds())}.${extensionOf(type)}`;

/** A drop's payload. Files win over the text a drag also carries: a file manager offers the file's
 * local URI as text, which names nothing on a remote workspace. A folder refuses the whole drop. */
export const droppedPayload = (data: DataTransfer): TerminalPayload => {
  const items = Array.from(data.items).filter((item) => item.kind === "file");
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) return { kind: "folder", name: entry.name };
  }
  const files = Array.from(data.files).map((file) => ({ name: file.name, blob: file }));
  if (files.length > 0) return { kind: "files", files };
  const text = data.getData("text/plain");
  return text === "" ? { kind: "empty" } : { kind: "text", text };
};

/** The system clipboard's payload. Text wins: copying from a page puts text and an image on the
 * clipboard together, and the text is what was meant. Otherwise an image, in the first image type
 * the item offers. A file copied in a file manager is not something the browser's clipboard hands
 * over (only images and text are), so it pastes as whatever text the file manager put beside it.
 * Without the rich clipboard API (or its permission) this is the plain text read the paste chords
 * always made. */
export const clipboardPayload = async (clipboard: Clipboard, now: () => Date): Promise<TerminalPayload> => {
  if (typeof clipboard.read === "function") {
    try {
      const items = await clipboard.read();
      for (const item of items) {
        if (!item.types.includes("text/plain")) continue;
        const text = await (await item.getType("text/plain")).text();
        if (text !== "") return { kind: "text", text };
      }
      const files: TerminalUpload[] = [];
      for (const item of items) {
        const type = item.types.find((candidate) => candidate.startsWith("image/"));
        if (type === undefined) continue;
        files.push({ name: clipboardFileName(type, now()), blob: await item.getType(type) });
      }
      if (files.length > 0) return { kind: "files", files };
    } catch {
      // A denied permission or a clipboard that will not answer: the plain read below decides.
    }
  }
  const text = await clipboard.readText().catch(() => "");
  return text === "" ? { kind: "empty" } : { kind: "text", text };
};
