import { useSession } from "../app/session";
import { TabletSettingsButton } from "../native/TabletSettingsButton";
import { AccountPanel } from "../auth/AccountPanel";
import { THEME_LIST } from "./themes";
import { KindleSettings } from "../kindle/KindleSettings";
import { StorytellerSetupLink } from "../storyteller/SetupLink";
import { ReadingHelpForMe } from "./ReadingHelp";

/** Big picture buttons so kids who can't read yet can still pick a theme. */
export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useSession();
  return (
    <div className={`bb-theme-picker${compact ? " is-compact" : ""}`} role="radiogroup" aria-label="Theme">
      {THEME_LIST.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={t.id === theme.id}
          className="bb-theme-swatch"
          onClick={() => setTheme(t.id)}
          style={{
            background: t.colors.bg,
            color: t.colors.text,
            borderColor: t.id === theme.id ? t.colors.accent : t.colors.border,
            fontFamily: t.displayFont,
            borderRadius: t.radius,
          }}
        >
          <span className="bb-theme-emoji" aria-hidden>
            {t.emoji}
          </span>
          <span>{t.name}</span>
          <span className="bb-theme-dots" aria-hidden>
            <i style={{ background: t.colors.accent }} />
            <i style={{ background: t.colors.surface2 }} />
            <i style={{ background: t.colors.readerBg, borderColor: t.colors.border }} />
          </span>
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { me } = useSession();
  return (
    <div className="bb-page">
      {me && !me.isKid && <AccountPanel />}
      <h1 className="bb-h1">{me?.isKid ? "Pick your colors" : "Appearance"}</h1>
      <ThemePicker />
      <h2 className="bb-section-h2">{me?.isKid ? "Reading help" : "Reading help (this device)"}</h2>
      <ReadingHelpForMe />
      <KindleSettings />
      <StorytellerSetupLink />
      <TabletSettingsButton />
    </div>
  );
}
