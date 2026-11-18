/**
 * The OSC readers: the reporter's status parser (`ESC ] 1337 ; corvi = <base64 json> BEL`, or ST)
 * and the scanner that reads the titles a terminal is given (`OSC 0`, `1`, `2`). Both are pure and
 * live apart from `host.ts` so they can be unit-tested without a pty.
 *
 * The parser is deliberately defensive: it holds only a *genuine partial prefix* of the
 * introducer, resyncs past a malformed or oversized sequence rather than discarding the rest of
 * the chunk, and validates the decoded payload before it can reach a presenter. Resync means the
 * introducer is dropped and the bytes after it are forwarded as ordinary output — a malformed
 * sequence's tail can reach the display, it is only its control prefix that is removed. The
 * payload is untrusted data from inside the pty — the same trust model the pane options had.
 *
 * The title scanner is the opposite in one respect: it removes nothing. A title is the terminal's
 * own name for itself, and the display is entitled to the same bytes it would get from any
 * terminal; the scanner only reads along.
 */
export type OscStatus = {
  readonly status: "working" | "waiting" | "clear";
  readonly name?: string;
  readonly message?: string;
  readonly sessionName?: string;
};

export const OSC_INTRO = Buffer.from("\x1b]1337;corvi=", "ascii");
export const OSC_ST = Buffer.from("\x1b\\", "ascii");
export const MAX_OSC_CARRY = 8192;
export const MAX_OSC_PAYLOAD = 4096;
export const NAME_CAP = 120;
export const MESSAGE_CAP = 400;

const isBase64 = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x2b || // +
  byte === 0x2f || // /
  byte === 0x3d; // =

/** The longest suffix of `buffer` that is a prefix of the introducer: only that many bytes may be
 * held for the next chunk. Holding a fixed tail would delay ordinary output. */
const partialIntroLength = (buffer: Buffer): number => {
  const max = Math.min(buffer.length, OSC_INTRO.length - 1);
  for (let len = max; len > 0; len--) {
    if (buffer.subarray(buffer.length - len).equals(OSC_INTRO.subarray(0, len))) return len;
  }
  return 0;
};

const text = (value: unknown, cap: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, cap) : undefined;

/** Validate a decoded payload: an unknown status or a non-string field is dropped, never
 * forwarded; strings are capped. */
export const sanitizeStatus = (raw: unknown): OscStatus | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.status !== "working" && value.status !== "waiting" && value.status !== "clear") return undefined;
  const name = text(value.name, NAME_CAP);
  const message = text(value.message, MESSAGE_CAP);
  const sessionName = text(value.sessionName, NAME_CAP);
  return {
    status: value.status,
    ...(name ? { name } : {}),
    ...(message ? { message } : {}),
    ...(sessionName ? { sessionName } : {}),
  };
};

export type OscParse = {
  /** Bytes safe to forward to the display. */
  readonly clean: Buffer;
  /** A held partial introducer or sequence, for the next chunk. */
  readonly carry: Buffer;
  readonly statuses: OscStatus[];
};

/** The OSC numbers that name a terminal: 0 sets the icon and window title together, 1 the tab
 * (icon) name, 2 the window title. Programs use whichever their terminal understands — a shell's
 * prompt sets 1 and 2, an application often only 0 or 2. */
const TITLE_CODES: ReadonlySet<string> = new Set(["0", "1", "2"]);

/** OSC 7, which is not a name: the shell announces the directory it is in, so a terminal can put
 * it in the tab. Prompts that set titles usually set this too (oh-my-zsh does both at each
 * prompt), and it is the one fact that does not move when a command takes the title over. */
const CWD_CODE = "7";

/** A title is one line in a label, not a document: a prompt may pour a whole command line or a
 * deep path into it. */
export const TITLE_CAP = 200;

/** A cwd is a path, not a document either. A longer one is not a path we would name a window by. */
const CWD_CAP = 1024;

/** How much of an unterminated sequence the scanner holds for the next chunk. A title longer than
 * this is not one the pane would show. */
export const MAX_TITLE_CARRY = 2048;

const OSC_PREFIX = Buffer.from("\x1b]", "ascii");
const BEL_BYTE = 0x07;
const SEMICOLON_BYTE = 0x3b;
const ESC_BYTE = 0x1b;
const BACKSLASH_BYTE = 0x5c;

export type TerminalScan = {
  /** The newest title this chunk completed, if any. */
  readonly title?: string;
  /** The directory the shell announced in this chunk, if it announced one. */
  readonly directory?: string;
  /** Bytes to prepend to the next chunk: a sequence that had not finished at the end of this
   * one. Nothing is removed from the stream — the display bytes are the caller's own. */
  readonly carry: Buffer;
};

/** One line, no control characters, capped. What a title may carry into a label. */
const cleanTitle = (raw: Buffer): string =>
  raw
    .toString("utf8")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_CAP)
    .trim();

type Terminator = { readonly end: number; readonly length: number } | "incomplete" | "stray";

/** Where a control string ends: BEL, or ST (`ESC \\`). A lone ESC at the end of the chunk may be
 * the start of ST; an ESC followed by anything else is not part of a title we can trust. */
const findTerminator = (buffer: Buffer, from: number): Terminator => {
  for (let at = from; at < buffer.length; at++) {
    const byte = buffer[at]!;
    if (byte === BEL_BYTE) return { end: at, length: 1 };
    if (byte !== ESC_BYTE) continue;
    if (at + 1 >= buffer.length) return "incomplete";
    if (buffer[at + 1] === BACKSLASH_BYTE) return { end: at, length: 2 };
    return "stray";
  }
  return "incomplete";
};

/** The path in an OSC 7 `file://host/path` announcement, percent-decoded, or nothing when it is not
 * an absolute file URI. The host part is ignored: the shell runs on this machine, and a remote
 * workspace's server does the reading where it runs. */
export const cwdFromOsc7 = (payload: string): string | undefined => {
  const prefix = "file://";
  if (!payload.toLowerCase().startsWith(prefix)) return undefined;
  const rest = payload.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(rest.slice(slash));
  } catch {
    // A malformed escape is not a path; the last good one stands.
    return undefined;
  }
  return path.startsWith("/") && path.length <= CWD_CAP ? path : undefined;
};

/**
 * Read what a terminal says about itself in a pty chunk — its title (`OSC 0`, `1`, `2`) and the
 * directory its shell announces (`OSC 7`) — without touching a byte of it: the scanner only
 * observes, so the display keeps every sequence it would have had. The newest of each in the chunk
 * wins, as in xterm: a program that sets only the window title takes over from the prompt's tab
 * title, and the prompt takes it back at the next prompt.
 *
 * Everything else in the OSC namespace is left alone — the reporter's `1337`, links, colours,
 * clipboard, and a program's own status channel — so a name never comes from a sequence meant for
 * something else.
 */
export const scanTerminal = (input: Buffer, carry: Buffer): TerminalScan => {
  const buf = carry.length > 0 ? Buffer.concat([carry, input]) : input;
  const held = (from: number): Buffer => Buffer.from(buf.subarray(from));
  const found = (title: string | undefined, directory: string | undefined, next: Buffer): TerminalScan => ({
    ...(title !== undefined ? { title } : {}),
    ...(directory !== undefined ? { directory } : {}),
    carry: next,
  });
  let title: string | undefined;
  let directory: string | undefined;
  let at = 0;
  for (;;) {
    const start = buf.indexOf(OSC_PREFIX, at);
    if (start === -1) {
      // A trailing lone ESC may be the first half of an introducer split across chunks.
      const keep = buf.length > 0 && buf[buf.length - 1] === ESC_BYTE ? 1 : 0;
      return found(title, directory, Buffer.from(buf.subarray(buf.length - keep)));
    }
    const codeStart = start + OSC_PREFIX.length;
    const semicolon = buf.indexOf(SEMICOLON_BYTE, codeStart);
    if (semicolon === -1) {
      // No code yet: either it is still arriving, or this is not a control string at all.
      if (buf.length - codeStart <= 3) return found(title, directory, held(start));
      at = codeStart;
      continue;
    }
    const code = buf.subarray(codeStart, semicolon).toString("ascii");
    const kind = code === CWD_CODE ? "cwd" : TITLE_CODES.has(code) ? "title" : undefined;
    if (kind === undefined || code.length !== 1) {
      // A link, a colour, a status: not this scanner's, and the bytes stay untouched.
      at = semicolon + 1;
      continue;
    }
    const bodyStart = semicolon + 1;
    const terminator = findTerminator(buf, bodyStart);
    if (terminator === "stray") {
      // A raw ESC inside the payload: the sequence is malformed. Resume after the introducer, so
      // a later, valid one is still read.
      at = bodyStart;
      continue;
    }
    if (terminator === "incomplete") {
      if (buf.length - start > MAX_TITLE_CARRY) {
        at = bodyStart;
        continue;
      }
      return found(title, directory, held(start));
    }
    const nested = buf.indexOf(OSC_PREFIX, bodyStart);
    if (nested !== -1 && nested < terminator.end) {
      // An introducer started before this one ended: the first sequence never completed.
      at = bodyStart;
      continue;
    }
    const body = buf.subarray(bodyStart, terminator.end);
    if (kind === "cwd") {
      const cwd = cwdFromOsc7(body.toString("utf8"));
      if (cwd !== undefined) directory = cwd;
    } else {
      const text = cleanTitle(body);
      // An empty title is how a program clears one; keeping the last real name is friendlier than
      // falling back to the window's directory mid-run.
      if (text !== "") title = text;
    }
    at = terminator.end + terminator.length;
  }
};

/** Split pty bytes into displayable output and any status sequences. An incomplete sequence is
 * carried to the next chunk; a malformed one has its introducer dropped and the rest resynced as
 * ordinary output (so a broken reporter cannot swallow the chunk, though its tail can show). */
export const parseOsc = (input: Buffer, carry: Buffer): OscParse => {
  let buf = carry.length > 0 ? Buffer.concat([carry, input]) : input;
  const out: Buffer[] = [];
  const statuses: OscStatus[] = [];
  for (;;) {
    const start = buf.indexOf(OSC_INTRO);
    if (start === -1) {
      const keep = partialIntroLength(buf);
      out.push(buf.subarray(0, buf.length - keep));
      return { clean: Buffer.concat(out), carry: buf.subarray(buf.length - keep), statuses };
    }
    out.push(buf.subarray(0, start));
    const after = start + OSC_INTRO.length;
    if (after >= buf.length) {
      // The introducer itself might still be arriving.
      return { clean: Buffer.concat(out), carry: buf.subarray(start), statuses };
    }
    if (!isBase64(buf[after]!)) {
      // Not a status payload at all: drop just the introducer and resume ordinary parsing.
      buf = buf.subarray(after);
      continue;
    }
    const bel = buf.indexOf(0x07, after);
    const st = buf.indexOf(OSC_ST, after);
    let end = -1;
    let term = 0;
    if (bel !== -1 && (st === -1 || bel < st)) {
      end = bel;
      term = 1;
    } else if (st !== -1) {
      end = st;
      term = OSC_ST.length;
    }
    const nextIntro = buf.indexOf(OSC_INTRO, after);
    const nested = nextIntro !== -1 && (end === -1 || nextIntro < end);
    const tooLong = end !== -1 && end - after > MAX_OSC_PAYLOAD;
    if (nested || tooLong) {
      // A new introducer started before this one terminated, or the payload is absurd: the
      // first sequence is malformed. Drop its introducer only, so the rest is still parsed.
      buf = buf.subarray(after);
      continue;
    }
    if (end === -1) {
      if (buf.length - after > MAX_OSC_CARRY) {
        // Oversized and unterminated: resync rather than swallowing the chunk.
        buf = buf.subarray(after);
        continue;
      }
      return { clean: Buffer.concat(out), carry: buf.subarray(start), statuses };
    }
    try {
      const json = JSON.parse(
        Buffer.from(buf.subarray(after, end).toString("ascii"), "base64").toString("utf8"),
      );
      const status = sanitizeStatus(json);
      if (status) statuses.push(status);
    } catch {
      // malformed payload: dropped
    }
    buf = buf.subarray(end + term);
  }
};
