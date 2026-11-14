/** Pick the read-aloud voice and speed for yourself (or, from the family page, for a kid). */
import { useEffect, useState } from "react";
import { readAloudApi, type VoicePrefs } from "./api";

/** Kokoro voice ids look like af_heart: accent+gender, then a name. */
export function voiceName(id: string): string {
  const m = /^([abefhijpz])([fm])_(.+)$/.exec(id);
  if (!m) return id;
  const accent: Record<string, string> = { a: "American", b: "British", e: "Spanish", f: "French", h: "Hindi", i: "Italian", j: "Japanese", p: "Portuguese", z: "Chinese" };
  const name = m[3]!.charAt(0).toUpperCase() + m[3]!.slice(1);
  return `${name} (${accent[m[1]!] ?? m[1]}, ${m[2] === "f" ? "female" : "male"})`;
}

export function VoicePicker({ userId, kid, onClose }: { userId: string; kid: boolean; onClose(changed: boolean): void }) {
  const [voices, setVoices] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<VoicePrefs | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    readAloudApi.voices().then((v) => setVoices(v.voices), () => undefined);
    readAloudApi.prefs(userId).then(setPrefs, () => undefined);
  }, [userId]);

  const save = async (p: { voice: string | null; speed: number }) => {
    setSaving(true);
    try {
      setPrefs(await readAloudApi.savePrefs(userId, p));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="bb-ra-scrim" onClick={() => onClose(false)} />
      <div className={`bb-ra-picker${kid ? " is-kid" : ""}`} role="dialog" aria-label="Reading voice">
        <header>
          <h2>{kid ? "Who should read to you?" : "Reading voice"}</h2>
          <button className="bb-icon-btn" onClick={() => onClose(false)} aria-label="Close">
            ✕
          </button>
        </header>
        {!prefs && <p className="bb-muted">Loading…</p>}
        {prefs && (
          <>
            <ul className="bb-ra-voices">
              {[null, ...voices].map((v) => (
                <li key={v ?? "default"}>
                  <label>
                    <input type="radio" name="voice" checked={prefs.voice === v} disabled={!prefs.canEdit || saving} onChange={() => void save({ voice: v, speed: prefs.speed })} />
                    <span>{v ? voiceName(v) : "The family's usual voice"}</span>
                  </label>
                </li>
              ))}
            </ul>
            <label className="bb-field">
              <span>Speed: {prefs.speed.toFixed(2)}×</span>
              <input
                type="range"
                min={0.6}
                max={1.4}
                step={0.05}
                value={prefs.speed}
                disabled={!prefs.canEdit}
                onChange={(e) => setPrefs({ ...prefs, speed: Number(e.target.value) })}
                onPointerUp={() => void save({ voice: prefs.voice, speed: prefs.speed })}
                onKeyUp={() => void save({ voice: prefs.voice, speed: prefs.speed })}
              />
            </label>
            <div className="bb-ra-picker-foot">
              <button className="bb-btn bb-btn-primary" onClick={() => onClose(true)}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
