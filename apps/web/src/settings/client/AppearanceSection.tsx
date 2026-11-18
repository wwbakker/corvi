import { type JSX, useState } from "react";
import { DEFAULT_THEME, THEMES, type ThemeId } from "../../domain/theme.ts";
import { chooseTheme, themeInUse } from "../../app-root/theme.ts";

/**
 * The theme picker.
 *
 * A theme is per device, not part of the config file: the choice is the browser's cookie and it
 * applies the moment it is picked, so this section sits outside the page's draft and has no save
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
        The theme belongs to this device: the browser keeps it, and picking one applies it at once. There is
        nothing to save here.
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
    </div>
  );
}
