import type { JSX } from "react";
import { windowGlyph } from "./rail.ts";

/**
 * The navigation and status glyphs: terminals, builds, agents, the destinations and the page.
 *
 * Monochrome and drawn with `currentColor`, so a state is a colour rather than a different
 * picture — the shape says which thing is being talked about, the colour says how it is doing.
 * Kept to one or two strokes each: at thirteen pixels anything more turns into a smudge.
 *
 * The change's own state is not here: it is the coloured bar down the left of its row, which
 * needs no glyph and reads from further away. Its avatar is drawn from initials, not a glyph.
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

/** Subagents: the agent's head, antenna and all, with a smaller head below and to its right —
 * the agent and the one working for it. Deliberately not the `AgentIcon` head: a subagent window
 * is listed beside agent windows, and the two must be told apart at a glance. The primary head is
 * strictly larger and keeps both eyes and the antenna; the smaller head has room for one centred
 * eye, drawn with a finer stroke so it does not fill the face. A clear gap keeps the two outlines
 * apart, so at thirteen pixels they read as two heads rather than welding into one shape. */
export function SubagentIcon({ title }: { title: string }): JSX.Element {
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
      <rect x="1.5" y="1.8" width="9" height="5" rx="1.6" />
      <path d="M6 1.8V1.2" />
      <path d="M4.3 4.3h.01M7.7 4.3h.01" />
      <rect x="9.4" y="10.3" width="4.6" height="4.6" rx="1.5" />
      <path strokeWidth="1.4" d="M11.7 12.6h.01" />
    </svg>
  );
}

/** Changes: the overview's house — the destination that is home. */
export function ChangesIcon({ title }: { title: string }): JSX.Element {
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
      <path d="M2.5 7.5 8 2.5l5.5 5" />
      <path d="M4.5 7.5V13.5h7V7.5" />
    </svg>
  );
}

/** New: the plus that starts an idea. */
export function PlusIcon({ title }: { title: string }): JSX.Element {
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
      <path d="M8 3v10" />
      <path d="M3 8h10" />
    </svg>
  );
}

/** Actions: a bolt — something runs when you press it. Filled, where the stroke is only the
 * outline: at thirteen pixels a stroked bolt's inner angles close up. */
export function ActionsIcon({ title }: { title: string }): JSX.Element {
  return (
    <svg {...size} fill="currentColor" role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M9.2 1.5 3.5 9.2H7.2L6.6 14.5 12.5 6.8H8.8z" />
    </svg>
  );
}

/** A page an extension contributes: the generic document, when it declares no icon of its own. */
export function PageIcon({ title }: { title: string }): JSX.Element {
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
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

/** Leftovers: a box for the directories nothing claims. */
export function LeftoversIcon({ title }: { title: string }): JSX.Element {
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
      <rect x="2.5" y="3.5" width="11" height="3" rx="0.5" />
      <path d="M3.5 6.5v7h9v-7" />
      <path d="M6.5 9.5h3" />
    </svg>
  );
}

/** A window's glyph, from the name the server presented it under. The rail and the window tabs
 * both draw this one component, so the same window cannot look like two different things. An
 * unknown name falls back to the terminal, as the contract says. */
export function WindowIcon({ icon, title }: { icon?: string; title: string }): JSX.Element {
  switch (windowGlyph(icon)) {
    case "subagent":
      return <SubagentIcon title={title} />;
    case "agent":
      return <AgentIcon title={title} />;
    case "terminal":
      return <TerminalIcon title={title} />;
  }
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
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 1.8V5h-3.2" />
    </svg>
  );
}
