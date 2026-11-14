import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RATING_LABELS, type ContentRating } from "@bookbandit/shared";
import { isDemo } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import {
  AI_FEATURES,
  aiApi,
  type AiFeature,
  type AiSettings,
  type ProviderSettings,
  type RatingRunStatus,
  type RatingSuggestion,
} from "./api";
import "./ai.css";

const FEATURE_LABELS: Record<AiFeature, [string, string]> = {
  chat: ["Grown-up chat", "Barnaby for adults"],
  kidChat: ["Kid chat", "Falls back to grown-up chat"],
  bookChat: ["Book chat", "Spoiler-free chat in the reader; falls back to grown-up chat"],
  moderation: ["Moderation", "Checks kids' messages and answers (Llama Guard works well)"],
  rating: ["Rating helper", "Suggests ratings for unrated books"],
};

/** Presets for the "Add provider" menu. Setup details for each: docs/ai.md. */
const PRESETS: { label: string; p: ProviderSettings }[] = [
  {
    label: "Ollama (local)",
    p: { id: "ollama", name: "Ollama", kind: "openai", baseUrl: "http://ollama:11434/v1", model: "llama3.2" },
  },
  {
    label: "LM Studio (local)",
    p: { id: "lmstudio", name: "LM Studio", kind: "openai", baseUrl: "http://lmstudio:1234/v1", model: "" },
  },
  {
    label: "llama.cpp server (local)",
    p: { id: "llamacpp", name: "llama.cpp", kind: "openai", baseUrl: "http://llamacpp:8080/v1", model: "default" },
  },
  {
    label: "OpenAI",
    p: { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" },
  },
  { label: "Anthropic (Claude)", p: { id: "claude", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5" } },
  { label: "Google Gemini", p: { id: "gemini", name: "Gemini", kind: "gemini", model: "gemini-2.5-flash" } },
];

/** /barnaby/settings (admins): providers, which feature uses which, web search, kid defaults, rating helper. */
export function AiSettingsPage() {
  const { me } = useSession();
  const [s, setS] = useState<AiSettings | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [run, setRun] = useState<RatingRunStatus | null>(null);
  const [suggestions, setSuggestions] = useState<RatingSuggestion[]>([]);
  const [searchTest, setSearchTest] = useState<string | null>(null);

  // The demo signs in as a parent; let it show this page too.
  const admin = me?.role === "admin" || isDemo;

  useEffect(() => {
    if (!admin) return;
    aiApi.settings().then(setS, (e: Error) => setError(e.message));
    aiApi.ratingStatus().then(setRun, () => {});
    aiApi.suggestions().then(setSuggestions, () => {});
  }, [admin]);

  useEffect(() => {
    if (!run?.running) return;
    const t = setInterval(() => {
      aiApi.ratingStatus().then((r) => {
        setRun(r);
        if (!r.running) void aiApi.suggestions().then(setSuggestions);
      });
    }, 1500);
    return () => clearInterval(t);
  }, [run?.running]);

  if (me && !admin) return <BarnabyEmpty title="Only an admin can change Barnaby's settings" />;
  if (error && !s) return <p className="bb-page bb-error">{error}</p>;
  if (!s) return <div className="bb-page bb-muted">Loading…</div>;

  const set = (patch: Partial<AiSettings>) => setS({ ...s, ...patch });
  const setProvider = (i: number, patch: Partial<ProviderSettings>) =>
    set({ providers: s.providers.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  function addPreset(label: string) {
    const preset = PRESETS.find((p) => p.label === label);
    if (!preset) return;
    let id = preset.p.id;
    for (let n = 2; s!.providers.some((p) => p.id === id); n++) id = `${preset.p.id}-${n}`;
    set({ providers: [...s!.providers, { ...preset.p, id }] });
  }

  async function save() {
    setError(null);
    setSaved(null);
    try {
      setS(await aiApi.saveSettings(s!));
      setSaved("Saved");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="bb-page bb-ai-settings">
      <p className="bb-crumbs">
        <Link to="/barnaby">← Barnaby</Link>
      </p>
      <h1>Barnaby settings</h1>
      <p className="bb-muted">
        Barnaby can run on a model in your own house (Ollama, LM Studio, llama.cpp) or a cloud service. Pick a provider per
        feature. Setup guide: <code>docs/ai.md</code>.
      </p>

      <section className="bb-settings-card">
        <h2>Providers</h2>
        {s.providers.length === 0 && <p className="bb-muted">No providers yet. Add one below.</p>}
        {s.providers.map((p, i) => (
          <fieldset key={i} className="bb-provider">
            <legend>
              {p.name || p.id} <span className="bb-muted">({p.kind === "openai" ? "OpenAI-compatible" : p.kind})</span>
            </legend>
            <div className="bb-form-grid">
              <label>
                Name
                <input value={p.name} onChange={(e) => setProvider(i, { name: e.target.value })} />
              </label>
              <label>
                Id
                <input value={p.id} onChange={(e) => setProvider(i, { id: e.target.value.toLowerCase() })} />
              </label>
              <label>
                Kind
                <select value={p.kind} onChange={(e) => setProvider(i, { kind: e.target.value as ProviderSettings["kind"] })}>
                  <option value="openai">OpenAI-compatible (Ollama…)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </label>
              <label>
                Base URL
                <input
                  value={p.baseUrl ?? ""}
                  placeholder={p.kind === "openai" ? "http://ollama:11434/v1" : "(default)"}
                  onChange={(e) => setProvider(i, { baseUrl: e.target.value || undefined })}
                />
              </label>
              <label>
                Model
                <input value={p.model} list={`models-${i}`} onChange={(e) => setProvider(i, { model: e.target.value })} />
                <datalist id={`models-${i}`}>
                  {(models[p.id] ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label>
                API key
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={p.hasApiKey ? "•••••• (saved)" : p.kind === "openai" ? "Not needed for local servers" : "Required"}
                  value={p.apiKey ?? ""}
                  onChange={(e) => setProvider(i, { apiKey: e.target.value })}
                />
              </label>
            </div>
            <div className="bb-provider-actions">
              <button
                type="button"
                className="bb-btn bb-btn-small"
                onClick={() =>
                  void aiApi
                    .testProvider(p.id)
                    .then((r) =>
                      setTests((t) => ({
                        ...t,
                        [p.id]: r.ok ? `✅ ${r.model} said “${r.reply}” in ${(r.ms / 1000).toFixed(1)} s` : `❌ ${r.error}`,
                      })),
                    )
                }
              >
                Test
              </button>
              <button
                type="button"
                className="bb-btn bb-btn-small"
                onClick={() =>
                  void aiApi.models(p.id).then(
                    (m) => setModels((all) => ({ ...all, [p.id]: m })),
                    (e: Error) => setTests((t) => ({ ...t, [p.id]: `❌ ${e.message}` })),
                  )
                }
              >
                Load models
              </button>
              <button
                type="button"
                className="bb-btn bb-btn-small"
                onClick={() => set({ providers: s.providers.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
              {tests[p.id] && <span className="bb-test-result">{tests[p.id]}</span>}
            </div>
          </fieldset>
        ))}
        <label className="bb-field-inline">
          Add provider
          <select value="" onChange={(e) => addPreset(e.target.value)}>
            <option value="">Choose…</option>
            {PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
          </select>
        </label>
        <p className="bb-muted bb-small">Save before testing a new or changed provider.</p>
      </section>

      <section className="bb-settings-card">
        <h2>Who does what</h2>
        <div className="bb-form-grid">
          {AI_FEATURES.map((f) => (
            <label key={f}>
              {FEATURE_LABELS[f][0]}
              <select
                value={s.features[f] ?? ""}
                onChange={(e) => set({ features: { ...s.features, [f]: e.target.value || null } })}
              >
                <option value="">{f === "kidChat" || f === "bookChat" ? "Same as grown-up chat" : "Off"}</option>
                {s.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))}
              </select>
              <span className="bb-muted bb-small">{FEATURE_LABELS[f][1]}</span>
            </label>
          ))}
        </div>
        <label className="bb-switch">
          <input
            type="checkbox"
            checked={s.moderation.adults}
            onChange={(e) => set({ moderation: { adults: e.target.checked } })}
          />
          Also moderate grown-ups' chats (kids are always moderated)
        </label>
        <label className="bb-field-inline">
          Default questions per day for kids
          <input
            type="number"
            min={1}
            max={500}
            value={s.kidDefaults.dailyLimit}
            onChange={(e) => set({ kidDefaults: { dailyLimit: Math.max(1, Number(e.target.value) || 1) } })}
          />
        </label>
      </section>

      <section className="bb-settings-card">
        <h2>Web search (SearXNG)</h2>
        <label className="bb-switch">
          <input
            type="checkbox"
            checked={s.search.enabled}
            onChange={(e) => set({ search: { ...s.search, enabled: e.target.checked } })}
          />
          Let Barnaby search the web
        </label>
        <div className="bb-form-grid">
          <label>
            SearXNG URL
            <input
              value={s.search.url ?? ""}
              placeholder="http://searxng:8080"
              onChange={(e) => set({ search: { ...s.search, url: e.target.value || undefined } })}
            />
          </label>
          <label>
            Safe search for grown-ups
            <select
              value={s.search.safeSearch}
              onChange={(e) => set({ search: { ...s.search, safeSearch: Number(e.target.value) as 0 | 1 | 2 } })}
            >
              <option value={0}>Off</option>
              <option value={1}>Moderate</option>
              <option value={2}>Strict</option>
            </select>
          </label>
        </div>
        <label>
          Sites kids' answers may use (one per line). Kids always get strict safe search.
          <textarea
            rows={5}
            value={s.search.kidAllowlist.join("\n")}
            onChange={(e) => set({ search: { ...s.search, kidAllowlist: e.target.value.split(/\s+/).filter(Boolean) } })}
          />
        </label>
        <button
          type="button"
          className="bb-btn bb-btn-small"
          onClick={() =>
            void aiApi
              .testSearch("dinosaurs", true)
              .then((r) => setSearchTest(r.ok ? `✅ ${r.items.length} kid-safe results` : `❌ ${r.error}`))
          }
        >
          Test a kid search
        </button>
        {searchTest && <span className="bb-test-result">{searchTest}</span>}
      </section>

      <div className="bb-settings-save">
        <button type="button" className="bb-btn bb-btn-primary" onClick={() => void save()}>
          Save settings
        </button>
        {saved && <span>{saved}</span>}
        {error && <span className="bb-error">{error}</span>}
      </div>

      <section className="bb-settings-card">
        <h2>Rating helper</h2>
        <p className="bb-muted">
          Barnaby reads unrated books and suggests a rating. A stricter suggestion is applied straight away (it can only hide a
          book from kids); anything looser waits here for you.
        </p>
        <button
          type="button"
          className="bb-btn"
          disabled={run?.running}
          onClick={() => void aiApi.startRating(25).then(setRun, (e: Error) => setError(e.message))}
        >
          {run?.running ? `Rating… ${run.done}/${run.total}` : "Rate 25 unrated books"}
        </button>
        {run && !run.running && run.total > 0 && (
          <span className="bb-test-result">
            Last run: {run.suggested} suggested, {run.applied} applied, {run.failed} failed
          </span>
        )}
        <ul className="bb-suggestions">
          {suggestions.map((g) => (
            <li key={g.bookId}>
              <div>
                <strong>{g.title}</strong>
                <span className="bb-muted">
                  {" "}
                  · now {g.currentRating ? RATING_LABELS[g.currentRating as ContentRating] : "unrated (adult)"}
                </span>
                <p>
                  Suggests <b>{RATING_LABELS[g.rating as ContentRating] ?? g.rating}</b> ({Math.round(g.confidence * 100)}%):{" "}
                  {g.reasons}
                </p>
              </div>
              <button
                type="button"
                className="bb-btn bb-btn-small bb-btn-primary"
                onClick={() => void aiApi.acceptSuggestion(g.bookId).then(() => setSuggestions((l) => l.filter((x) => x !== g)))}
              >
                Accept
              </button>
              <button
                type="button"
                className="bb-btn bb-btn-small"
                onClick={() => void aiApi.dismissSuggestion(g.bookId).then(() => setSuggestions((l) => l.filter((x) => x !== g)))}
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
