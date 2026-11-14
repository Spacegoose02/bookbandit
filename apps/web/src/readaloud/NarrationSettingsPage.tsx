/** Admin: the read-aloud speech server (Kokoro-FastAPI or Piper), default voices and the clip cache. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isDemo } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { Card, ErrorNote, formatBytes } from "../admin/ui";
import { readAloudApi, type NarrationAdmin, type NarrationSettingsInput, type TestResult } from "./api";
import { voiceName } from "./VoicePicker";
import "./readaloud.css";

const PRESETS = [
  { label: "Kokoro-FastAPI", baseUrl: "http://kokoro:8880/v1", model: "kokoro", defaultVoice: "af_heart", kidVoice: "af_bella", wordTimings: true },
  { label: "Piper (openedai-speech)", baseUrl: "http://openedai-speech:8000/v1", model: "tts-1", defaultVoice: "alloy", kidVoice: "nova", wordTimings: false },
];

export function NarrationSettingsPage() {
  const { me } = useSession();
  const admin = me?.role === "admin" || isDemo;
  const [data, setData] = useState<NarrationAdmin | null>(null);
  const [form, setForm] = useState<NarrationSettingsInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!admin) return;
    readAloudApi.adminSettings().then(
      (d) => {
        setData(d);
        const { hasApiKey: _k, ...s } = d.settings;
        setForm(s);
      },
      (e: Error) => setError(e.message),
    );
  }, [admin]);

  if (!admin) return <BarnabyEmpty title="Only an admin can change read-aloud settings" />;
  if (!form || !data) return <p className="bb-page bb-muted">{error ?? "Loading…"}</p>;

  const set = <K extends keyof NarrationSettingsInput>(k: K, v: NarrationSettingsInput[K]) => {
    setSaved(false);
    setForm({ ...form, [k]: v });
  };
  const save = async () => {
    setError(null);
    try {
      const d = await readAloudApi.saveSettings(form);
      setData(d);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await readAloudApi.saveSettings(form);
      setTest(await readAloudApi.test());
    } catch (e) {
      setTest({ ok: false, ms: 0, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bb-page bb-ra-settings">
      <p className="bb-small">
        <Link className="bb-link" to="/admin">
          ← Admin
        </Link>
      </p>
      <h1 className="bb-h1">Read-aloud voices</h1>
      <p className="bb-muted">
        A local speech server reads books aloud in the reader and in storyteller mode, with each word lit up as it's spoken. Without one, the device's own voice is used. Books with
        a recorded narrator (EPUB3 read-along) always use their own audio.
      </p>
      <ErrorNote error={error} />

      <Card title="Speech server">
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          <span>Use a speech server for read-aloud</span>
        </label>
        <div className="bb-ra-presets">
          {PRESETS.map((p) => (
            <button key={p.label} className="bb-btn bb-btn-ghost" onClick={() => setForm({ ...form, ...p, enabled: true })}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="bb-field">
          <span>Address (up to /v1)</span>
          <input className="bb-input" value={form.baseUrl ?? ""} placeholder="http://kokoro:8880/v1" onChange={(e) => set("baseUrl", e.target.value || undefined)} />
        </label>
        <div className="bb-ra-row">
          <label className="bb-field">
            <span>Model</span>
            <input className="bb-input" value={form.model} onChange={(e) => set("model", e.target.value)} />
          </label>
          <label className="bb-field">
            <span>API key {data.settings.hasApiKey ? "(saved)" : "(optional)"}</span>
            <input className="bb-input" type="password" value={form.apiKey ?? ""} placeholder={data.settings.hasApiKey ? "••••••••" : ""} onChange={(e) => set("apiKey", e.target.value)} />
          </label>
        </div>
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={form.wordTimings} onChange={(e) => set("wordTimings", e.target.checked)} />
          <span>Ask for word timings (Kokoro-FastAPI), so the highlight follows every word exactly</span>
        </label>
        <div className="bb-ra-row">
          <button className="bb-btn" onClick={runTest} disabled={testing || !form.baseUrl}>
            {testing ? "Testing…" : "Save and test"}
          </button>
          {test && (
            <span className={test.ok ? "bb-ra-ok" : "bb-ra-no"} role="status">
              {test.ok
                ? `Works: answered in ${test.ms} ms${test.wordTimings ? " with word timings" : ""}, ${test.voices?.length ?? 0} voices`
                : `Didn't work: ${test.error}`}
            </span>
          )}
        </div>
      </Card>

      <Card title="Voices">
        <div className="bb-ra-row">
          <label className="bb-field">
            <span>Grown-ups' voice</span>
            <input className="bb-input" value={form.defaultVoice} onChange={(e) => set("defaultVoice", e.target.value)} />
            <small className="bb-muted">{voiceName(form.defaultVoice)}</small>
          </label>
          <label className="bb-field">
            <span>Kids' voice</span>
            <input className="bb-input" value={form.kidVoice ?? ""} placeholder="Same as grown-ups" onChange={(e) => set("kidVoice", e.target.value || null)} />
            {form.kidVoice && <small className="bb-muted">{voiceName(form.kidVoice)}</small>}
          </label>
        </div>
        <label className="bb-field">
          <span>Voices people can pick (comma-separated; only needed when the server can't list its own)</span>
          <input
            className="bb-input"
            value={form.voices.join(", ")}
            onChange={(e) =>
              set(
                "voices",
                e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
        <p className="bb-muted bb-small">Everyone can pick their own voice and speed from the reader's read-aloud bar. Parents set them for kids on the family page.</p>
      </Card>

      <Card title="Saved audio">
        <p>
          {data.cache.clips.toLocaleString()} clips, {formatBytes(data.cache.bytes)} in <code>{data.cacheDir}</code>. A chapter read once plays instantly the next time.
        </p>
        <div className="bb-ra-row">
          <label className="bb-field">
            <span>Keep up to (MB)</span>
            <input className="bb-input" type="number" min={10} value={form.cacheMb} onChange={(e) => set("cacheMb", Number(e.target.value) || 500)} />
          </label>
          <button
            className="bb-btn bb-btn-ghost"
            onClick={() => void readAloudApi.clearCache().then(() => setData({ ...data, cache: { clips: 0, bytes: 0 } }))}
          >
            Clear saved audio
          </button>
        </div>
      </Card>

      <div className="bb-ra-row">
        <button className="bb-btn bb-btn-primary" onClick={save}>
          Save
        </button>
        {saved && <span className="bb-ra-ok">Saved</span>}
      </div>
    </div>
  );
}
