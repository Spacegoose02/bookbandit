import { useSession } from "../app/session";
import { TabletSettingsButton } from "../native/TabletSettingsButton";
import { AccountPanel } from "../auth/AccountPanel";
import { useState } from "react";
import { THEME_GROUPS, THEME_LIST, type Theme } from "./themes";
import { buddyGroupsFor, saveAvatar } from "./buddies";
import { KindleSettings } from "../kindle/KindleSettings";
import { StorytellerSetupLink } from "../storyteller/SetupLink";
import { ReadingHelpForMe } from "./ReadingHelp";

/** Big picture buttons so kids who can't read yet can still pick a theme, grouped so grown-ups can find a calm one. */
export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme, me } = useSession();
  // Kids see the picture worlds first; grown-ups see the calm reading themes first.
  const groups = me?.isKid ? THEME_GROUPS : [THEME_GROUPS[1]!, THEME_GROUPS[0]!, THEME_GROUPS[2]!];
  return (
    <div className={`bb-theme-groups${compact ? " is-compact" : ""}`} role="radiogroup" aria-label="Theme">
      {groups.map((g) => {
        const list = THEME_LIST.filter((t) => t.group === g.id);
        if (!list.length) return null;
        return (
          <div key={g.id} className="bb-theme-group">
            <h3 className="bb-theme-group-h">{me?.isKid ? g.kid : g.grownUp}</h3>
            <div className={`bb-theme-picker${compact ? " is-compact" : ""}`}>
              {list.map((t) => (
                <ThemeSwatch key={t.id} t={t} on={t.id === theme.id} pick={() => setTheme(t.id)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ThemeSwatch({ t, on, pick }: { t: Theme; on: boolean; pick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={`bb-theme-swatch${t.scene ? " has-scene" : ""}`}
      onClick={pick}
      style={{
        background: t.colors.bg,
        color: t.colors.text,
        borderColor: on ? t.colors.accent : t.colors.border,
        fontFamily: t.displayFont,
        borderRadius: t.radius,
      }}
    >
      {t.scene && <span className="bb-theme-scene" aria-hidden style={{ backgroundImage: t.scene }} />}
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
  );
}

/** Pick your buddy: the picture next to your name. Offers the theme's own buddies first. */
export function BuddyPicker() {
  const { me, theme, updateMe } = useSession();
  const [error, setError] = useState(false);
  if (!me) return null;
  const pick = (avatar: string | null) => {
    const before = me.avatar;
    setError(false);
    updateMe({ avatar });
    saveAvatar(me.id, avatar).catch(() => {
      updateMe({ avatar: before });
      setError(true);
    });
  };
  return (
    <div className="bb-buddies">
      {buddyGroupsFor(theme).map((g) => (
        <div key={g.id} className="bb-buddy-group" role="radiogroup" aria-label={g.name}>
          <h3 className="bb-theme-group-h">{g.name}</h3>
          <div className="bb-buddy-grid">
            {g.buddies.map((b) => (
              <button
                key={`${g.id}-${b}`}
                type="button"
                role="radio"
                aria-checked={me.avatar === b}
                aria-label={b}
                className="bb-buddy"
                onClick={() => pick(b)}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      ))}
      {me.avatar && (
        <button type="button" className="bb-btn" onClick={() => pick(null)}>
          No buddy
        </button>
      )}
      {error && (
        <p className="bb-error" role="alert">
          {me.isKid ? "Barnaby couldn't save your buddy. Try again!" : "Couldn't save your picture. Try again."}
        </p>
      )}
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
      <h2 className="bb-section-h2">
        {me?.isKid ? "Pick your buddy" : "Your picture"} {me?.avatar && <span aria-hidden>{me.avatar}</span>}
      </h2>
      <BuddyPicker />
      <h2 className="bb-section-h2">{me?.isKid ? "Reading help" : "Reading help (this device)"}</h2>
      <ReadingHelpForMe />
      <KindleSettings />
      <StorytellerSetupLink />
      <TabletSettingsButton />
    </div>
  );
}
