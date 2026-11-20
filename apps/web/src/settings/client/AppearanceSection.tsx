import { type JSX, useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES, type ThemeId } from "../../domain/theme.ts";
import { chooseTheme, themeInUse } from "../../app-root/theme.ts";
import { chooseMonoFont, monoFontInUse, loadSymbolsFont } from "../../app-root/monoFont.ts";
import { InfoIcon } from "../../app-root/icons.tsx";

/**
 * The theme picker and the monospace font.
 *
 * Both are per device, not part of the config file: the choice is the browser's cookie and it
 * applies the moment it is made, so this section sits outside the page's draft and has no save
 * of its own. The swatches are painted from each theme's tokens (`styles.css`), not from colours
 * repeated here.
 */
export function AppearanceSection(): JSX.Element {
  const [theme, setTheme] = useState<ThemeId>(themeInUse);

  const pick = (choice: ThemeId): void => {
    chooseTheme(choice);
    setTheme(choice);
  };

  return (
    <div className="form">
      <p className="hint">
        The theme and the font belong to this device: the browser keeps them, and a choice applies at once.
        There is nothing to save here.
      </p>
      <div className="theme-choices" role="radiogroup" aria-label="Theme">
        {THEMES.map((choice) => (
          <label key={choice.id} className={choice.id === theme ? "theme-choice current" : "theme-choice"}>
            <input
              type="radio"
              name="theme"
              value={choice.id}
              checked={choice.id === theme}
              onChange={() => pick(choice.id)}
            />
            <span className="preview" data-theme={choice.id} aria-hidden="true" />
            <span className="name">
              {choice.name}
              {choice.id === DEFAULT_THEME && <span className="badge">default</span>}
            </span>
            <span className="blurb">{choice.blurb}</span>
          </label>
        ))}
      </div>
      <MonoFontField />
    </div>
  );
}

/**
 * The family that goes in front of the page's monospace stack, typed by name. It applies as it is
 * typed, so the field itself — which is set in that stack — previews it. A div rather than a
 * `<label>`: the info button inside one would be named by the label, and a click on it would focus
 * the input.
 */
function MonoFontField(): JSX.Element {
  const [typed, setTyped] = useState<string>(monoFontInUse);
  /** Null until the check answers: no warning flashes up while the font is still loading. */
  const [symbolsLoaded, setSymbolsLoaded] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    void loadSymbolsFont().then((loaded) => {
      if (current) setSymbolsLoaded(loaded);
    });
    return () => {
      current = false;
    };
  }, []);

  const change = (value: string): void => {
    setTyped(value);
    chooseMonoFont(value);
  };

  return (
    <div className="field mono-font">
      <span className="label">
        <label htmlFor="mono-font">Monospace font</label>
        {/* A button only so the tip can be reached by keyboard: it shows on hover and on focus. */}
        <button
          type="button"
          className="info-tip"
          aria-label="Finding a font's name"
          aria-describedby="mono-font-where"
        >
          <InfoIcon />
          <span className="tip" role="tooltip" id="mono-font-where">
            Type the font&apos;s family name as your system lists it. On macOS, open <b>Font Book</b> and use
            the name shown for the family, e.g. <code>JetBrainsMono Nerd Font Mono</code>. On Linux, run{" "}
            <code>fc-list : family</code> in a terminal.
          </span>
        </button>
      </span>
      <input
        id="mono-font"
        value={typed}
        placeholder="Empty: the system's monospace font"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => change(e.target.value)}
      />
      <small>
        Used by terminals, the editor and code. A font that is not installed falls back to the default. Icons
        that programs print, such as pi&apos;s footer, come from the bundled Nerd Fonts symbols either way.
      </small>
      {symbolsLoaded === false && (
        <small className="warn">
          The bundled icon font did not load, so those icons show as boxes. Run <code>bun run fonts</code>,
          then rebuild.
        </small>
      )}
    </div>
  );
}
