import type { JSX } from "react";

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
export function TerminalIcon({ title }: { title: string }): JSX.Element {
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
export function CiIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg {...size} fill="currentColor" role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M4 2.8l9 5.2-9 5.2z" />
    </svg>
  );
}

/** Coding agents: a head with eyes and an antenna — the machine that talks back. */
export function AgentIcon({ title }: { title: string }): JSX.Element {
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
      <rect x="3" y="5.5" width="10" height="7.5" rx="2" />
      <path d="M8 5.5V2.5" />
      <path d="M5.75 9.25h.01M10.25 9.25h.01" />
    </svg>
  );
}

/** Settings: a gear — the column's bottom row, where you go once in a while. The one glyph drawn
 * on a 24 grid: the familiar cog outline, which at thirteen pixels a hand-drawn tooth ring turns
 * into a sunburst. */
export function GearIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Updates: an arrow turning back on itself — the app fetching its own new version. */
export function UpdateIcon({ title }: { title: string }): JSX.Element {
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
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 1.8V5h-3.2" />
    </svg>
  );
}
