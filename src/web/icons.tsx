/**
 * The status icons: one glyph for terminals, one for builds.
 *
 * Monochrome and drawn with `currentColor`, so a state is a colour rather than a different
 * picture — the shape says which thing is being talked about, the colour says how it is doing.
 * Kept to one or two strokes each: at thirteen pixels anything more turns into a smudge.
 *
 * The change's own state is not here: it is the coloured bar down the left of its row, which
 * needs no glyph and reads from further away.
 */

const size = { width: 13, height: 13, viewBox: "0 0 16 16" } as const;

/** Terminals: a prompt. */
export function TerminalIcon({ title }: { title: string }) {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M2.5 4l3.5 4-3.5 4" />
      <path d="M8.5 12.5h5.5" />
    </svg>
  );
}

/** Builds: the button you press to start one. */
export function CiIcon({ title }: { title: string }) {
  return (
    <svg {...size} fill="currentColor" role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M4 2.8l9 5.2-9 5.2z" />
    </svg>
  );
}
