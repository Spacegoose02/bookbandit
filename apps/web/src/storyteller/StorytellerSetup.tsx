import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_STORYTELLER_SETTINGS, STORYTELLER_MAX_COVERS, STORYTELLER_MIN_COVERS, type StorytellerSettings } from "@bookbandit/shared";
import { api } from "../api/client";
import type { BookSummary } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty, BarnabySays } from "../brand/Barnaby";
import { Cover } from "../library/BookCard";
import { storytellerApi, type HistoryItem, type KidProfile, type StorytellerScreen } from "./api";
import "./storyteller.css";

const STORY_CHOICES = [null, 1, 2, 3, 4, 5, 6, 8, 10] as const;
const MINUTE_CHOICES = [null, 10, 15, 20, 30, 45, 60, 90] as const;
const SLEEP_CHOICES = [null, 10, 15, 20, 30, 45, 60] as const;

function hourLabel(h: number): string {
  if (h === 0) return "Midnight";
  if (h === 12) return "Noon";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** Grown-ups: /storyteller/setup. Pick stories and set the nightly limits for each little one. */
export function StorytellerSetup() {
  const { me } = useSession();
  const [kids, setKids] = useState<KidProfile[] | null>(null);
  const [kidId, setKidId] = useState<string | null>(null);

  useEffect(() => {
    if (!me || me.isKid) return;
    storytellerApi.kids().then(
      (k) => {
        setKids(k);
        setKidId(k[0]?.id ?? null);
      },
      () => setKids([]),
    );
  }, [me]);

  if (me?.isKid) return <BarnabyEmpty title="Ask a grown-up to change story time." />;
  if (!kids) return <div className="bb-page bb-muted">Loading…</div>;
  if (!kids.length)
    return (
      <BarnabyEmpty title="No kids to set up yet">
        <p>Story time is for a kid's profile. Add a kid (or ask an admin to link you as their parent) first.</p>
      </BarnabyEmpty>
    );

  return (
    <div className="bb-page bb-story-setup">
      <h1 className="bb-h1">Story time</h1>
      <BarnabySays>
        Pick up to {STORYTELLER_MAX_COVERS} stories and a bedtime limit. Barnaby says goodnight when tonight's stories are done,
        and the server holds the limit even if the tablet is restarted.
      </BarnabySays>
      {kids.length > 1 && (
        <div className="bb-chips" role="tablist" aria-label="Kid">
          {kids.map((k) => (
            <button key={k.id} role="tab" className="bb-chip" aria-pressed={k.id === kidId} onClick={() => setKidId(k.id)}>
              {k.avatar ? `${k.avatar} ` : ""}
              {k.displayName}
            </button>
          ))}
        </div>
      )}
      {kidId && <KidSetup key={kidId} kidId={kidId} />}
    </div>
  );
}

function KidSetup({ kidId }: { kidId: string }) {
  const [screen, setScreen] = useState<StorytellerScreen | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    storytellerApi.screen(kidId).then(setScreen, (e: Error) => setError(e.message));
    storytellerApi.history(kidId).then(setHistory, () => setHistory([]));
  };
  useEffect(reload, [kidId]);

  if (error) return <p className="bb-error">{error}</p>;
  if (!screen) return <p className="bb-muted">Loading…</p>;
  const name = screen.kid.displayName;

  return (
    <div className="bb-story-setup-body">
      <Tonight screen={screen} />
      <SettingsForm
        name={name}
        initial={screen.settings}
        canEdit={screen.canEdit}
        onSave={async (s) => {
          const r = await storytellerApi.saveSettings(kidId, s);
          setScreen({ ...screen, settings: r.settings, tonight: r.tonight });
        }}
      />
      <StoryPicker kidId={kidId} name={name} screen={screen} onChange={reload} />
      {history.length > 0 && (
        <section className="bb-settings-section">
          <h2>Lately</h2>
          <ul className="bb-story-history">
            {history.slice(0, 15).map((h) => (
              <li key={h.id}>
                <span>{h.title}</span>
                <span className="bb-muted">
                  {new Date(h.startedAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} ·{" "}
                  {Math.max(1, Math.round(h.listenedSeconds / 60))} min{h.mode === "read_aloud" ? " · read aloud" : ""}
                  {h.completed ? " · finished" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Tonight({ screen }: { screen: StorytellerScreen }) {
  const t = screen.tonight;
  const s = screen.settings;
  const parts = [
    s.storiesPerNight != null ? `${t.storiesUsed} of ${s.storiesPerNight} stories` : `${t.storiesUsed} stories`,
    s.minutesPerNight != null
      ? `${Math.round(t.secondsUsed / 60)} of ${s.minutesPerNight} minutes`
      : `${Math.round(t.secondsUsed / 60)} minutes`,
  ];
  return (
    <p className="bb-story-tonight-summary">
      <b>Tonight:</b> {parts.join(", ")}
      {t.goodnight ? ". Story time is over until tomorrow." : "."}
    </p>
  );
}

function SettingsForm({
  name,
  initial,
  canEdit,
  onSave,
}: {
  name: string;
  initial: StorytellerSettings;
  canEdit: boolean;
  onSave(s: StorytellerSettings): Promise<void>;
}) {
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [s, setS] = useState<StorytellerSettings>(() =>
    initial.timeZone === DEFAULT_STORYTELLER_SETTINGS.timeZone && !initial.enabled ? { ...initial, timeZone: deviceTz } : initial,
  );
  const [status, setStatus] = useState<string | null>(null);
  const set = <K extends keyof StorytellerSettings>(k: K, v: StorytellerSettings[K]) => (setS({ ...s, [k]: v }), setStatus(null));
  const num = (v: string) => (v === "" ? null : Number(v));

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await onSave(s);
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="bb-settings-section bb-story-form" onSubmit={submit}>
      <h2>Bedtime rules</h2>
      <fieldset disabled={!canEdit}>
        <label className="bb-field-inline bb-story-toggle">
          <input type="checkbox" checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          <span>Open story time when {name} signs in</span>
        </label>
        <div className="bb-story-form-grid">
          <label className="bb-field">
            <span>Stories per night</span>
            <select className="bb-input" value={s.storiesPerNight ?? ""} onChange={(e) => set("storiesPerNight", num(e.target.value))}>
              {STORY_CHOICES.map((n) => (
                <option key={String(n)} value={n ?? ""}>
                  {n == null ? "No limit" : n}
                </option>
              ))}
            </select>
          </label>
          <label className="bb-field">
            <span>Minutes per night</span>
            <select className="bb-input" value={s.minutesPerNight ?? ""} onChange={(e) => set("minutesPerNight", num(e.target.value))}>
              {MINUTE_CHOICES.map((n) => (
                <option key={String(n)} value={n ?? ""}>
                  {n == null ? "No limit" : `${n} minutes`}
                </option>
              ))}
            </select>
          </label>
          <label className="bb-field">
            <span>Sleep timer</span>
            <select className="bb-input" value={s.sleepTimerMinutes ?? ""} onChange={(e) => set("sleepTimerMinutes", num(e.target.value))}>
              {SLEEP_CHOICES.map((n) => (
                <option key={String(n)} value={n ?? ""}>
                  {n == null ? "Off" : `${n} minutes`}
                </option>
              ))}
            </select>
          </label>
          <label className="bb-field">
            <span>A new night starts at</span>
            <select className="bb-input" value={s.nightStartsHour} onChange={(e) => set("nightStartsHour", Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="bb-field-inline bb-story-toggle">
          <input type="checkbox" checked={s.readAloud} onChange={(e) => set("readAloud", e.target.checked)} />
          <span>Read picture books aloud with the tablet's voice when there's no audiobook</span>
        </label>
        <p className="bb-muted bb-small">
          Nights are counted in {s.timeZone}.
          {s.timeZone !== deviceTz && (
            <>
              {" "}
              <button type="button" className="bb-link bb-linkbtn" onClick={() => set("timeZone", deviceTz)}>
                Use {deviceTz}
              </button>
            </>
          )}
        </p>
        <button className="bb-btn bb-btn-primary">Save</button>
        {status && <span className="bb-story-status">{status}</span>}
      </fieldset>
    </form>
  );
}

function StoryPicker({ kidId, name, screen, onChange }: { kidId: string; name: string; screen: StorytellerScreen; onChange(): void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<BookSummary[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const full = screen.stories.length >= STORYTELLER_MAX_COVERS;
  const onShelf = new Set(screen.stories.map((s) => s.id));

  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ ratings: "kids", sort: "title", limit: "12" });
      if (q.trim()) params.set("q", q.trim());
      api.books(params).then((r) => setResults(r.items.filter((b) => !b.kindleOnly)), () => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function toggle(bookId: string, on: boolean) {
    setMessage(null);
    try {
      await storytellerApi.setStory(kidId, bookId, on);
      onChange();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="bb-settings-section bb-story-picker">
      <h2>
        {name}'s stories ({screen.stories.length}/{STORYTELLER_MAX_COVERS})
      </h2>
      {screen.stories.length < STORYTELLER_MIN_COVERS && (
        <p className="bb-muted bb-small">Story time looks best with {STORYTELLER_MIN_COVERS} to {STORYTELLER_MAX_COVERS} books.</p>
      )}
      <div className="bb-story-pick-grid">
        {screen.stories.map((s) => (
          <div key={s.id} className="bb-story-pick">
            <Cover book={s} />
            <span className="bb-small">
              {s.hasAudio ? "🎧 Audiobook" : s.canReadAloud ? "🗣️ Read aloud" : "No audio"}
            </span>
            <button className="bb-btn bb-btn-ghost" onClick={() => void toggle(s.id, false)} aria-label={`Remove ${s.title}`}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <h3>Add a story</h3>
      <input className="bb-input bb-search" type="search" placeholder="Search kids' books" value={q} onChange={(e) => setQ(e.target.value)} />
      {message && <p className="bb-error">{message}</p>}
      <div className="bb-story-pick-grid">
        {results
          .filter((b) => !onShelf.has(b.id))
          .map((b) => (
            <div key={b.id} className="bb-story-pick">
              <Cover book={b} />
              <span className="bb-small">{b.title}</span>
              <button className="bb-btn" disabled={full} onClick={() => void toggle(b.id, true)}>
                Add
              </button>
            </div>
          ))}
      </div>
    </section>
  );
}
