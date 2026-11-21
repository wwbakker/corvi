import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { isConfirmChord, modalOpen, type Keyish } from "./confirmShortcut.ts";

/**
 * Leader mode: `Ctrl+Space` lays a keycap on every control the current page offers, and the next
 * key goes there. The caps are the discoverable half — nothing has to be memorized — and the keys
 * are positional: each group of controls reads in the order it is laid out, so a control's key is
 * where it sits rather than what it is.
 *
 * The page takes the chord ahead of everything else, in the capture phase on `document`: inside a
 * terminal xterm would otherwise encode it as NUL (the shell's `set-mark`) and the mode would
 * never open where it is most useful. On macOS the system can take `Ctrl+Space` for itself
 * (Settings → Keyboard → Keyboard Shortcuts → Input Sources); the manual says so.
 *
 * A modal `<dialog>` owns the keyboard while it is open, so the chord does nothing there — the
 * wizard's browsers and the dialogs over a page have their own keys.
 *
 * The mode ends on the pointer's mousedown, and a shell surface that moves under a press (the
 * narrow window's drawer) closes itself only after that gesture has finished; the mode tells no
 * one how to do that, and no control has to opt out of it.
 */

/** The chord's key, as one constant rather than a setting: Ctrl plus this, and nothing else. */
const LEADER_CODE = "Space";

/** `Ctrl+Space` exactly: any other modifier held leaves the chord to whoever else wants it. */
export const isLeaderChord = (event: Keyish): boolean =>
  event.code === LEADER_CODE && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;

/** The character of a printable key, matched on `code` so a keyboard layout's composition under a
 * modifier (macOS reports one for Option+letter) never changes which position was pressed. The
 * two brackets are the history keys; the digits have their own reader. */
export const characterOf = (code: string): string | undefined => {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1]?.toLowerCase();
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  return undefined;
};

/** The slot a number key picks: `1`–`9` are the first nine, `0` is the tenth. */
export const digitOf = (code: string): number | undefined => {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (match === null) return undefined;
  const digit = Number(match[1]);
  return digit === 0 ? 9 : digit - 1;
};

/** Which key each slot of a group gets: the group's letters in order, and nothing past the end of
 * them. A slot with no key in it is still a slot — the entries keep their positions. */
export const keysFor = (keys: string, count: number): readonly (string | undefined)[] =>
  Array.from({ length: count }, (_, index) => keys[index]);

/** One control a letter reaches: the keycap sits on the element, and pressing the key clicks it. */
export type LeaderTarget = {
  readonly element: HTMLElement | null;
  /** What the key does, where a click is not what the control needs (focusing the plan editor). */
  readonly run?: () => void;
  /** Where the keycap sits on the control: inside its trailing corner by default; `above` lifts it
   * out of a button whose label runs to the edge, and `start` puts it at the leading corner. */
  readonly align?: Alignment;
  /** The click opens a menu that the mode then numbers; the mode stays on for it. */
  readonly keep?: boolean;
};

/** A control that selects one of a group of items: its letter picks the only item, or numbers the
 * group so a number or the arrows can pick one. */
export type LeaderSelector = {
  readonly kind: "selector";
  readonly element: HTMLElement | null;
  /** Read when the key is pressed, not when it is registered: the list changes while the mode is
   * on, and an empty group is a key that does nothing. */
  readonly items: () => readonly LeaderTarget[];
  /** The control drawn around the whole group; the items' own union when it is absent. */
  readonly outline?: () => HTMLElement | null;
  readonly align?: Alignment;
};

/** Where a keycap sits on its control. */
export type Alignment = "start" | "end" | "above";

/** One slot in a group: a control, a selector, or nothing (the key stays where it is). */
export type LeaderEntry = ({ readonly kind: "target" } & LeaderTarget) | LeaderSelector;

/** A menu that is open, which the mode numbers as soon as it appears. */
export type LeaderMenu = {
  readonly items: () => readonly LeaderTarget[];
  readonly outline: () => HTMLElement | null;
  readonly close: () => void;
};

type Group = {
  readonly keys: string;
  readonly entries: () => readonly (LeaderEntry | null)[];
};

/** Which items the mode is numbering: one selector's, or an open menu's. */
type Selection =
  | { readonly source: "group"; readonly group: string; readonly key: string; readonly index: number }
  | { readonly source: "menu"; readonly index: number };

type LeaderApi = {
  readonly active: boolean;
  readonly registerGroup: (id: string, group: Group) => () => void;
  readonly registerMenu: (id: string, menu: LeaderMenu) => () => void;
  /** The page's own `Ctrl+Enter`, for the pages that have one (the wizard's create). */
  readonly registerConfirm: (run: () => void) => () => void;
};

const LeaderContext = createContext<LeaderApi | null>(null);

/** Whether leader mode is on, for the shell's own parts of it (the narrow window's drawer). */
export const useLeaderActive = (): boolean => useContext(LeaderContext)?.active ?? false;

/** Register one group of controls: the keys, and a factory that reads them in visual order. The
 * factory runs at press time, so a list that changes under the mode is read as it is then. */
export function useLeaderGroup(
  id: string,
  keys: string,
  entries: () => readonly (LeaderEntry | null)[],
): void {
  const api = useContext(LeaderContext);
  useEffect(() => api?.registerGroup(id, { keys, entries }));
}

/** Offer the page's `Ctrl+Enter` to the mode: while the keycaps are up, the chord is the page's
 * as long as the page has something for it to do. Registering nothing keeps it unmapped, which is
 * what "a key with nothing to do leaves the mode alone" means. */
export function useLeaderConfirm(run: (() => void) | null): void {
  const api = useContext(LeaderContext);
  useEffect(() => {
    if (api === null || run === null) return;
    return api.registerConfirm(run);
  }, [api, run]);
}

/** Register a menu while it is open: the mode numbers its items and lets Escape close it. */
export function useLeaderMenu(open: boolean, makeMenu: () => LeaderMenu): void {
  const api = useContext(LeaderContext);
  const id = useId();
  useEffect(() => {
    if (api === null || !open) return;
    return api.registerMenu(id, makeMenu());
  }, [api, id, open]);
}

/** One box on screen, in the viewport's coordinates. */
type Box = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

const boxOf = (element: HTMLElement | null | undefined): Box | null => {
  if (element === null || element === undefined) return null;
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
};

/** The box around a group: what it said to draw, or the union of its items. */
const unionOf = (boxes: readonly Box[]): Box | null => {
  const first = boxes[0];
  if (first === undefined) return null;
  return boxes.reduce<Box>(
    (all, box) => ({
      left: Math.min(all.left, box.left),
      top: Math.min(all.top, box.top),
      right: Math.max(all.right, box.right),
      bottom: Math.max(all.bottom, box.bottom),
    }),
    first,
  );
};

const disabledAt = (target: LeaderTarget | undefined): boolean =>
  target?.element instanceof HTMLButtonElement && target.element.disabled;

/** The items a number reaches: the enabled ones, in order, at most ten. A disabled item gets no
 * number, the same way a disabled control gets no letter — its key would only do nothing. */
const numbered = (items: readonly LeaderTarget[]): readonly { item: LeaderTarget; index: number }[] =>
  items.flatMap((item, index) => (disabledAt(item) ? [] : [{ item, index }])).slice(0, 10);

/** The items a selection numbers, and the box drawn around them. */
type Resolved = {
  readonly items: () => readonly LeaderTarget[];
  readonly outline?: () => HTMLElement | null;
};

type Placement = {
  readonly label: string;
  readonly box: Box;
  readonly anchor: Alignment;
};

type LeaderLayout = {
  readonly keys: readonly Placement[];
  readonly numbers: readonly Placement[];
  readonly outline: Box | null;
  readonly highlight: Box | null;
};

/** What the layer draws, read from the registered groups: every key a control answers to, and,
 * while a group is being numbered, its numbers, its outline and the item the arrows are on. */
const layoutOf = (
  groups: ReadonlyMap<string, Group>,
  resolve: (chosen: Selection) => Resolved | null,
  selection: Selection | null,
): LeaderLayout => {
  const keys: Placement[] = [];
  // A numbered group is the only thing a letter reaches then, so the letters are not shown: a cap
  // on a dead key is the same lie as a cap on a disabled control.
  for (const [groupId, group] of selection === null ? groups : []) {
    const entries = group.entries();
    keysFor(group.keys, entries.length).forEach((key, index) => {
      const entry = entries[index];
      if (key === undefined || entry === null || entry === undefined) return;
      const numberingThis =
        selection?.source === "group" && selection.group === groupId && selection.key === key;
      if (numberingThis) return;
      // A disabled control cannot be pressed, so it gets no key of its own: the slot stays where
      // it is, and the key does nothing rather than looking like it works.
      if (entry.kind === "target" && disabledAt(entry)) return;
      const box = boxOf(entry.element);
      if (box === null) return;
      keys.push({ label: key.toUpperCase(), box, anchor: entry.align ?? "end" });
    });
  }

  if (selection === null) return { keys, numbers: [], outline: null, highlight: null };
  const chosen = resolve(selection);
  if (chosen === null) return { keys, numbers: [], outline: null, highlight: null };

  const items = chosen.items();
  const boxes = items.map((item) => boxOf(item.element));
  const numbers: Placement[] = [];
  numbered(items).forEach(({ item }, position) => {
    const box = boxOf(item.element);
    if (box === null) return;
    numbers.push({ label: position === 9 ? "0" : String(position + 1), box, anchor: "end" });
  });
  const outlineElement = chosen.outline?.();
  const outline = boxOf(outlineElement) ?? unionOf(boxes.filter((box): box is Box => box !== null));
  const current = boxes[selection.index] ?? null;
  return { keys, numbers, outline, highlight: current };
};

const KEY_SIZE = 18;

const badgeStyle = (box: Box, anchor: Alignment): { readonly left: number; readonly top: number } => {
  if (anchor === "above") return { left: box.right - KEY_SIZE / 2, top: box.top - KEY_SIZE / 2 };
  if (anchor === "start") return { left: box.left + 2, top: box.top + 2 };
  return { left: box.right - KEY_SIZE - 2, top: box.top + 2 };
};

export function LeaderProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const groups = useRef(new Map<string, Group>());
  const menus = useRef(new Map<string, LeaderMenu>());
  const [active, setActive] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [menuCount, setMenuCount] = useState(0);
  // Bumped when something the layout reads from the page changes under the mode: a menu opening,
  // a tab appearing, the column scrolling. Coordinates are read at render time, so this is what
  // makes a render happen at all.
  const [revision, setRevision] = useState(0);

  const registerGroup = useCallback((id: string, group: Group): (() => void) => {
    groups.current.set(id, group);
    return () => {
      if (groups.current.get(id) === group) groups.current.delete(id);
    };
  }, []);

  const registerMenu = useCallback((id: string, menu: LeaderMenu): (() => void) => {
    menus.current.set(id, menu);
    setMenuCount(menus.current.size);
    return () => {
      if (menus.current.get(id) === menu) menus.current.delete(id);
      setMenuCount(menus.current.size);
    };
  }, []);

  const confirm = useRef<(() => void) | null>(null);
  const registerConfirm = useCallback((run: () => void): (() => void) => {
    confirm.current = run;
    return () => {
      if (confirm.current === run) confirm.current = null;
    };
  }, []);

  const firstMenu = useCallback((): LeaderMenu | undefined => [...menus.current.values()][0], []);

  /** What a selection numbers: its items and the box around them. The layer and the keys read the
   * same answer, so a badge and the key that should reach it cannot disagree. */
  const resolve = useCallback(
    (chosen: Selection): Resolved | null => {
      if (chosen.source === "menu") {
        const menu = firstMenu();
        return menu === undefined ? null : { items: menu.items, outline: menu.outline };
      }
      const group = groups.current.get(chosen.group);
      if (group === undefined) return null;
      const index = [...group.keys].indexOf(chosen.key);
      const entry = group.entries()[index];
      return entry !== null && entry !== undefined && entry.kind === "selector" ? entry : null;
    },
    [firstMenu],
  );

  const itemsOf = useCallback(
    (chosen: Selection | null): readonly LeaderTarget[] =>
      chosen === null ? [] : (resolve(chosen)?.items() ?? []),
    [resolve],
  );

  const restore = useRef<HTMLElement | null>(null);
  /** The keys whose presses began in the mode and have not been released: their auto-repeats are
   * still those presses, not the surface's underneath. */
  const tail = useRef(new Set<string>());
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /** Leave the mode, with the keyboard back where it was unless an action has taken it. Every exit
   * comes through here: an open menu is the mode's and goes with it, whichever exit it was. */
  const finish = useCallback((restoreFocus: boolean, closeMenus = true): void => {
    const target = restore.current;
    restore.current = null;
    if (closeMenus) for (const menu of menus.current.values()) menu.close();
    setActive(false);
    setSelection(null);
    if (restoreFocus && target !== null && target.isConnected) target.focus({ preventScroll: true });
  }, []);

  /** Do what a control does, and leave the mode — unless it opens a menu, which is the next
   * layer of the same mode. */
  const activate = useCallback(
    (target: LeaderTarget): void => {
      const element = target.element;
      if (element === null) return;
      // A disabled control swallows the click anyway; ending the mode for it would say the key
      // worked.
      if (disabledAt(target)) return;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (target.run !== undefined) target.run();
      else element.click();
      if (target.keep !== true) finish(false);
    },
    [finish],
  );

  /** What the letter does: click a control, or pick the only item / number a group. */
  const choose = useCallback(
    (key: string): void => {
      for (const [groupId, group] of groups.current) {
        const index = [...group.keys].indexOf(key);
        if (index < 0) continue;
        const entry = group.entries()[index];
        if (entry === null || entry === undefined) return;
        if (entry.kind === "target") {
          activate(entry);
          return;
        }
        const items = entry.items();
        const reachable = numbered(items);
        const firstReachable = reachable[0];
        if (firstReachable === undefined) return;
        if (reachable.length === 1) {
          activate(firstReachable.item);
          return;
        }
        const first = items.findIndex((item) => !disabledAt(item));
        setSelection({ source: "group", group: groupId, key, index: first });
        return;
      }
    },
    [activate],
  );

  /** Walk the items the mode is numbering; the arrows wrap and step over what cannot be pressed. */
  const step = useCallback(
    (delta: number): void => {
      const chosen = selectionRef.current;
      if (chosen === null) return;
      const items = itemsOf(chosen);
      if (items.length === 0) return;
      let index = chosen.index;
      for (let moved = 0; moved < items.length; moved += 1) {
        index = (index + delta + items.length) % items.length;
        if (!disabledAt(items[index])) break;
      }
      setSelection({ ...chosen, index });
    },
    [itemsOf],
  );

  const chooseCurrent = useCallback((): void => {
    const chosen = selectionRef.current;
    if (chosen === null) return;
    const item = itemsOf(chosen)[chosen.index];
    if (item !== undefined && !disabledAt(item)) activate(item);
  }, [activate, itemsOf]);

  const start = useCallback((): void => {
    // A modal dialog owns the keyboard: its own keys and buttons are the whole surface then.
    if (modalOpen()) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection(null);
    setActive(true);
  }, []);

  const stop = useCallback((): void => {
    finish(true);
  }, [finish]);

  const api = useMemo<LeaderApi>(
    () => ({ active, registerConfirm, registerGroup, registerMenu }),
    [active, registerConfirm, registerGroup, registerMenu],
  );

  // An open menu is the mode's list as soon as it appears, whether the mode opened it or it was
  // already open when the mode did.
  useEffect(() => {
    if (!active) return;
    if (menuCount === 0) {
      setSelection((chosen) => (chosen?.source === "menu" ? null : chosen));
      return;
    }
    setSelection((chosen) => {
      if (chosen !== null) return chosen;
      const first = itemsOf({ source: "menu", index: 0 }).findIndex((item) => !disabledAt(item));
      return { source: "menu", index: first < 0 ? 0 : first };
    });
  }, [active, menuCount, itemsOf]);

  // The keyboard, in the capture phase on `document`: ahead of xterm's handler on the terminal's
  // own element, and ahead of the editor's. While the mode is on it takes every key it does not
  // use, so a stray letter never lands in a terminal; a key with nothing mapped does nothing.
  useEffect(() => {
    const take = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onKey = (event: KeyboardEvent): void => {
      // The press that ended the mode is still down: its auto-repeats belong to that press, not to
      // the surface underneath (a held Enter after a digit pick would type into the shell).
      if (!activeRef.current && event.repeat && tail.current.has(event.code)) {
        take(event);
        return;
      }
      if (isLeaderChord(event)) {
        take(event);
        // The chord is a physical press too: held across an exit (Ctrl+Space, Escape, release)
        // its own autorepeat must not fall into the surface underneath.
        tail.current.add(event.code);
        // Holding the chord must not open and close the mode on its own repeats — and a repeat
        // that fell through would be encoded by an xterm underneath as NUL.
        if (event.repeat) return;
        const dialogOpen = modalOpen();
        if (dialogOpen) {
          // The dialog owns the keyboard, and the chord must not press whatever it has focused:
          // Space is a button's activation key. The mode has no business being on there either.
          if (activeRef.current) stop();
          return;
        }
        if (activeRef.current) stop();
        else start();
        return;
      }
      if (!activeRef.current) return;
      // Every in-mode key is part of a physical press whose tail must not leak, if this one ends
      // the mode.
      tail.current.add(event.code);
      // A dialog can open under the mode without going through it — a guarded navigation from
      // `[`, an update notice. The dialog owns the keyboard then: the mode steps out and this key
      // is the dialog's.
      if (modalOpen()) {
        finish(false);
        return;
      }
      // The page's own confirm chord (the wizard's create, `Ctrl+Enter`) is the page's while the
      // keycaps that advertise it are up — but only where the page has one. Elsewhere it is an
      // unmapped key: taken, and the mode stays.
      if (isConfirmChord(event)) {
        take(event);
        const run = confirm.current;
        if (run === null) return;
        finish(false);
        run();
        return;
      }
      if (event.key === "Escape") {
        take(event);
        // Escape repeats through the layers in one physical press otherwise: the menu closes on
        // the first and the mode on the next.
        if (event.repeat) return;
        // An open menu is the outer layer: the mode closes it and stays. It is read from the page
        // because the menu is gone from the DOM before the state that numbered it has caught up.
        if (document.querySelector("[data-leader-menu]") !== null) {
          for (const menu of menus.current.values()) menu.close();
          setSelection(null);
          return;
        }
        const chosen = selectionRef.current;
        if (chosen !== null && chosen.source === "group") {
          setSelection(null);
          return;
        }
        // Nothing is numbered: a stale menu selection clears with the mode, in this one press.
        finish(true);
        return;
      }
      take(event);
      const chosen = selectionRef.current;
      if (chosen !== null) {
        const digit = digitOf(event.code);
        if (digit !== undefined) {
          const item = numbered(itemsOf(chosen))[digit]?.item;
          if (item !== undefined) activate(item);
          return;
        }
        if (event.code === "ArrowDown" || event.code === "ArrowRight") step(1);
        else if (event.code === "ArrowUp" || event.code === "ArrowLeft") step(-1);
        else if (event.code === "Enter" || event.code === "NumpadEnter") chooseCurrent();
        return;
      }
      const character = characterOf(event.code);
      if (character === "[" || character === "]") {
        // One press, one navigation: a held bracket must not walk the history.
        if (event.repeat) return;
        if (character === "[") window.history.back();
        else window.history.forward();
        return;
      }
      if (character !== undefined) {
        // One press, one action: a held letter must not toggle its menu at repeat rate.
        if (event.repeat) return;
        choose(character);
      }
    };
    const onUp = (event: KeyboardEvent): void => {
      tail.current.delete(event.code);
    };
    // A release the window never sees (alt-tab mid-press) must not keep eating the key later.
    const onBlur = (): void => tail.current.clear();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [activate, choose, chooseCurrent, finish, itemsOf, start, step, stop]);

  // Clicking away is the pointer's way out: the click still goes where it was aimed, and a press
  // on a control hands the keyboard to that control. A press on empty space hands it back to where
  // the mode took it — the terminal, usually. Both listeners stay on: the browser moves the focus
  // to <body> as the press's own default action after the mousedown, so the restore has to wait for
  // the release rather than run before it.
  const afterPress = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      // Whatever this press is, the last one's restore is over: a release outside the window never
      // reaches the listener, and the next click must not steal the focus back for it.
      afterPress.current = null;
      if (!activeRef.current) return;
      const target = event.target;
      const takesFocus =
        target instanceof Element &&
        target.closest("button, a, input, select, textarea, [tabindex], [contenteditable='true']") !== null;
      if (!takesFocus) afterPress.current = restore.current;
      // The press closes what it lands on: a menu item runs, a press outside a menu closes it
      // (ActionsMenu listens for that), and removing the menu here would eat the click.
      finish(false, false);
    };
    const onUp = (): void => {
      const target = afterPress.current;
      afterPress.current = null;
      // A press that took the keyboard keeps it: xterm focuses its textarea from a click on the
      // screen (a div, not a form control), and a button focuses itself. Only a press that left
      // the focus nowhere — a blank area, which the browser moves to <body> — gets it back.
      const active = document.activeElement;
      const nobody = active === null || active === document.body || active === document.documentElement;
      if (nobody && target !== null && target.isConnected) target.focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onUp, true);
    };
  }, [finish]);

  // The coordinates are read when the layer renders, so anything that moves a control or adds one
  // asks for a render: a scroll (the column and the tab row both scroll), a resize, or a change to
  // the page's elements (a menu opening, a tab arriving).
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const soon = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setRevision((count) => count + 1);
      });
    };
    const changed = (): void => {
      // A dialog can open under the mode without going through it: the dialog owns the keyboard
      // from the moment it is there.
      if (activeRef.current && modalOpen()) {
        finish(false);
        return;
      }
      soon();
    };
    const root = document.getElementById("root");
    const content = root === null ? null : new MutationObserver(changed);
    if (root !== null) {
      content?.observe(root, {
        childList: true,
        subtree: true,
        // A count or a status changing is a text node; a control appearing, a class on it, a
        // dialog opening.
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "hidden", "open"],
      });
    }
    // The narrow window's drawer opens by a class on <body>, outside the root, and taking it out
    // of the flow moves every key on the column.
    const page = new MutationObserver(changed);
    page.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("scroll", soon, true);
    window.addEventListener("resize", soon);
    return () => {
      content?.disconnect();
      page.disconnect();
      window.removeEventListener("scroll", soon, true);
      window.removeEventListener("resize", soon);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [active, finish]);

  // `revision` is what makes a render happen when the page moved; the layout reads the elements.
  const layer = useMemo(() => {
    void revision;
    return active ? layoutOf(groups.current, resolve, selection) : null;
  }, [active, resolve, revision, selection]);

  return (
    <LeaderContext.Provider value={api}>
      {children}
      {layer === null
        ? null
        : createPortal(
            <div className="leader-layer" aria-hidden="true">
              {layer.keys.map((key, index) => (
                <span
                  key={`key-${String(index)}`}
                  className="leader-key"
                  style={{ ...badgeStyle(key.box, key.anchor), width: KEY_SIZE, height: KEY_SIZE }}
                >
                  {key.label}
                </span>
              ))}
              {layer.numbers.map((number, index) => (
                <span
                  key={`number-${String(index)}`}
                  className="leader-key number"
                  style={{ ...badgeStyle(number.box, number.anchor), width: KEY_SIZE, height: KEY_SIZE }}
                >
                  {number.label}
                </span>
              ))}
              {layer.outline !== null && (
                <span
                  className="leader-outline"
                  style={{
                    left: layer.outline.left - 4,
                    top: layer.outline.top - 4,
                    width: layer.outline.right - layer.outline.left + 8,
                    height: layer.outline.bottom - layer.outline.top + 8,
                  }}
                />
              )}
              {layer.highlight !== null && (
                <span
                  className="leader-current"
                  style={{
                    left: layer.highlight.left - 2,
                    top: layer.highlight.top - 2,
                    width: layer.highlight.right - layer.highlight.left + 4,
                    height: layer.highlight.bottom - layer.highlight.top + 4,
                  }}
                />
              )}
            </div>,
            document.body,
          )}
    </LeaderContext.Provider>
  );
}
