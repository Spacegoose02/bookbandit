import { nativeApp } from "./native";

/** Link to the tablet app's own settings (offline books, kid safety). Grown-ups' PIN guards it. */
export function TabletSettingsButton() {
  const native = nativeApp();
  if (!native) return null;
  return (
    <section style={{ marginTop: 32 }}>
      <h2>This tablet</h2>
      <p className="bb-muted">Offline books, screen pinning and pairing. A grown-up's PIN may be needed.</p>
      <button type="button" className="bb-btn" onClick={() => native.openTabletSettings()}>
        Tablet settings
      </button>
    </section>
  );
}
