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

/** New: a plus. */
export function PlusIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** A branch: the two dots it connects, and the line between them — the change's row shows it
 * beside the branch's name. */
export function BranchIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="5.5" r="1.7" />
      <path d="M4.5 5.2v5.6" />
      <path d="M11.5 7.2c0 2.7-2.6 3.3-5.4 4" />
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

/** The navigation toggle a narrow window shows: a menu. Three strokes, the same weight as the
 * other glyphs. */
export function MenuIcon({ title }: { title: string }): JSX.Element {
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
      <path d="M2.5 4.5h11" />
      <path d="M2.5 8h11" />
      <path d="M2.5 11.5h11" />
    </svg>
  );
}

/** Power: the ring with its gap and stem — the once-in-a-while control that powers machines
 * down when their agents are done. */
export function PowerIcon({ title }: { title: string }): JSX.Element {
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
      <path d="M8 1.5v6" />
      <path d="M4.7 3.6a5 5 0 1 0 6.6 0" />
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
      <path d="M8 11.5V3M4.5 6.5 8 3l3.5 3.5" />
      <path d="M3 13.2h10" />
    </svg>
  );
}

/** A pane that can be driven from the keyboard: a keyboard, because that is what it opens. */
export function KeysIcon({ title }: { title: string }): JSX.Element {
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
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4.6 7h.01M8 7h.01M11.4 7h.01" />
      <path d="M5.5 9.8h5" />
    </svg>
  );
}

/** Refreshing a page's own data: a full circle closing on its arrowhead, which is the same idea as
 * the update arrow and has to read differently — this one re-reads what the page already shows,
 * it does not fetch a new version of the app. Two arcs with their own heads, drawn as one turn. */
export function RefreshIcon({ title }: { title: string }): JSX.Element {
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
      <path d="M2.8 6.2A5.3 5.3 0 0 1 13 5.4" />
      <path d="M13.2 9.8A5.3 5.3 0 0 1 3 10.6" />
      <path d="M12.4 2.2l.6 3.4-3.3-.7" />
      <path d="M3.6 13.8L3 10.4l3.3.7" />
    </svg>
  );
}

/* The column's and the tab row's glyphs. Same sixteen-unit frame and `currentColor` as the status
 * icons, at the size the rule that places them sets: an entry says what it is before its name,
 * and a view says which view it is. */

/** A menu that opens below its button: the chevron every menu trigger wears. */
export function ChevronDownIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  );
}

/** The overview: the list of changes, drawn as a page split by a heading line. */
export function ChangesIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M2 6.5h12" />
    </svg>
  );
}

/** Actions: something run, not something read. */
export function BoltIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M9 2 4 9h3.4L7 14l5-7H8.6z" />
    </svg>
  );
}

/** Subagents: one conversation opening two, the second still going. */
export function SubagentsIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <circle cx="4" cy="4" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="5.5" r="1.7" />
      <path d="M4 5.7V9a3 3 0 0 0 3 3h3.3" />
      <path d="M5.7 4h3.8a2.5 2.5 0 0 1 2.5 2.5V4.5" />
    </svg>
  );
}

/** Leftovers: work that stayed behind when something else moved on. */
export function LeftoversIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M2.5 4.5h11l-1 9h-9z" />
      <path d="M6 4.5V2.5h4v2" />
    </svg>
  );
}

/** Any other page an extension contributes. */
export function PageIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M3.5 2.5h6l3 3v8h-9z" />
      <path d="M9 2.5v3.5h3.5" />
    </svg>
  );
}

/** The plan: a page of writing. */
export function PlanIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M3.5 2.5h6l3 3v8h-9z" />
      <path d="M6 8h4M6 10.5h4M6 5.5h2" />
    </svg>
  );
}

/** The dashboard: cards of different heights, laid out beside each other. */
export function DashboardIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <rect x="2" y="2" width="5.2" height="6.5" rx="1.2" />
      <rect x="8.8" y="2" width="5.2" height="4" rx="1.2" />
      <rect x="8.8" y="7.5" width="5.2" height="6.5" rx="1.2" />
      <rect x="2" y="10" width="5.2" height="4" rx="1.2" />
    </svg>
  );
}

/** Reviewing the change's work: a pane with a tick on it. */
export function ReviewIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg
      {...size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M4.5 6.5h4M4.5 9h3" />
      <path d="m9.5 9.6 1.6 1.6 2.4-3" />
    </svg>
  );
}
