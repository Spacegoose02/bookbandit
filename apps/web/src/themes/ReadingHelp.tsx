import type { ReaderPrefs } from "../reader/readerCss";
import { useReaderPrefs } from "../reader/useReaderPrefs";
import { useSession } from "../app/session";
import "./themes.css";

/**
 * Reading helps with big picture buttons, so a kid (or a parent helping) can switch them on
 * without reading a menu: dyslexia-friendly letters (OpenDyslexic), easy-read letters
 * (Atkinson Hyperlegible) and the high-contrast theme. Shown in the reader's settings panel
 * for kids and on the Colors / Appearance page for everyone.
 */
export function ReadingHelp({ prefs, setPrefs }: { prefs: ReaderPrefs; setPrefs: (p: Partial<ReaderPrefs>) => void }) {
  const { theme, setTheme } = useSession();
  const font = prefs.fontFamily;
  const contrast = theme.id === "contrast";
  return (
    <div className="bb-reading-help" role="group" aria-label="Reading help">
      <button
        type="button"
        className="bb-help-toggle"
        aria-pressed={font === "dyslexic"}
        onClick={() => setPrefs({ fontFamily: font === "dyslexic" ? "sans" : "dyslexic" })}
      >
        <span className="bb-help-sample" style={{ fontFamily: `"OpenDyslexic", sans-serif` }} aria-hidden>
          Abc
        </span>
        <span>Dyslexia-friendly letters</span>
      </button>
      <button
        type="button"
        className="bb-help-toggle"
        aria-pressed={font === "sans"}
        onClick={() => setPrefs({ fontFamily: font === "sans" ? "book" : "sans" })}
      >
        <span className="bb-help-sample" style={{ fontFamily: `"Atkinson Hyperlegible", sans-serif` }} aria-hidden>
          Abc
        </span>
        <span>Easy-read letters</span>
      </button>
      <button type="button" className="bb-help-toggle" aria-pressed={contrast} onClick={() => setTheme(contrast ? "dark" : "contrast")}>
        <span className="bb-help-sample is-contrast" aria-hidden>
          Abc
        </span>
        <span>High contrast</span>
      </button>
    </div>
  );
}

/** ReadingHelp wired to this reader's saved text settings (for pages outside the reader). */
export function ReadingHelpForMe() {
  const { me } = useSession();
  const [prefs, setPrefs] = useReaderPrefs(me?.id ?? "anon", !!me?.isKid);
  return <ReadingHelp prefs={prefs} setPrefs={setPrefs} />;
}
