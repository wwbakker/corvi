/**
 * The OSC status parser: `ESC ] 1337 ; corvi = <base64 json> BEL` (or ST). Extracted from the
 * host so it can be unit-tested without booting a pty.
 *
 * The parser is deliberately defensive: it holds only a *genuine partial prefix* of the
 * introducer, resyncs past a malformed/oversized sequence rather than discarding the rest of the
 * chunk, and validates the decoded payload before it can reach a presenter.
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

const partialIntroLength = (buffer: Buffer): number => {
  const max = Math.min(buffer.length, OSC_INTRO.length - 1);
  for (let len = max; len > 0; len--) {
    if (buffer.subarray(buffer.length - len).equals(OSC_INTRO.subarray(0, len))) return len;
  }
  return 0;
};

const text = (value: unknown, cap: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, cap) : undefined;

/** Validate a decoded payload. An unknown status or a non-string field is dropped, never
 * forwarded; strings are capped. Same trust model as tmux pane options: the payload is
 * untrusted data from inside the pty. */
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
  /** A held partial introducer/sequence, for the next chunk. */
  readonly carry: Buffer;
  readonly statuses: OscStatus[];
};

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
      const json = JSON.parse(Buffer.from(buf.subarray(after, end).toString("ascii"), "base64").toString("utf8"));
      const status = sanitizeStatus(json);
      if (status) statuses.push(status);
    } catch {
      // malformed payload: dropped
    }
    buf = buf.subarray(end + term);
  }
};
