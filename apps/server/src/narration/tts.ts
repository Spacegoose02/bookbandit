/**
 * Talks to the local text-to-speech server. Plain OpenAI-compatible `/v1/audio/speech` works with
 * Kokoro-FastAPI and Piper (openedai-speech and friends). Kokoro-FastAPI also has
 * `/dev/captioned_speech`, which returns word timings for exact word highlighting; when it's
 * missing we fall back to plain speech and the web app estimates the timings.
 */
import type { NarrationSettings } from "./settings.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WordTiming {
  word: string;
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
}

export interface Speech {
  audio: Buffer;
  contentType: string;
  words: WordTiming[] | null;
}

export class TtsError extends Error {
  statusCode = 502;
}

/** `http://kokoro:8880/v1` → `http://kokoro:8880` (Kokoro's captioned endpoint lives outside /v1). */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function headers(s: NarrationSettings): Record<string, string> {
  return { "content-type": "application/json", ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) };
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await run(ctl.signal);
  } catch (e) {
    if (ctl.signal.aborted) throw new TtsError("The speech server took too long to answer");
    if (e instanceof TtsError) throw e;
    throw new TtsError(`Couldn't reach the speech server: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

/** Servers we found without the captioned endpoint, so we don't ask again every sentence. */
const noCaptions = new Set<string>();

export function parseTimestamps(raw: unknown): WordTiming[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WordTiming[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    const word = typeof t.word === "string" ? t.word : typeof t.text === "string" ? t.text : null;
    const start = Number(t.start_time ?? t.start);
    const end = Number(t.end_time ?? t.end);
    if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ word: word.trim(), start, end });
  }
  return out.length ? out : null;
}

export async function synthesize(
  fetchImpl: FetchLike,
  s: NarrationSettings,
  input: { text: string; voice: string; speed: number },
): Promise<Speech> {
  if (!s.baseUrl) throw new TtsError("No speech server is set up");
  const base = s.baseUrl.replace(/\/+$/, "");
  const body = { model: s.model, input: input.text, voice: input.voice, speed: input.speed, response_format: "mp3" };

  if (s.wordTimings && !noCaptions.has(base)) {
    const captioned = await withTimeout(s.timeoutMs, async (signal) => {
      const res = await fetchImpl(`${serverRoot(base)}/dev/captioned_speech`, {
        method: "POST",
        headers: headers(s),
        body: JSON.stringify({ ...body, stream: false, return_timestamps: true }),
        signal,
      });
      if (res.status === 404 || res.status === 405) {
        noCaptions.add(base);
        return null;
      }
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { audio?: string; timestamps?: unknown } | null;
      if (!json?.audio) return null;
      return { audio: Buffer.from(json.audio, "base64"), contentType: "audio/mpeg", words: parseTimestamps(json.timestamps) };
    });
    if (captioned) return captioned;
  }

  return withTimeout(s.timeoutMs, async (signal) => {
    const res = await fetchImpl(`${base}/audio/speech`, { method: "POST", headers: headers(s), body: JSON.stringify(body), signal });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new TtsError(`The speech server said ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new TtsError("The speech server sent back no audio");
    return { audio, contentType: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg", words: null };
  });
}

/** Voices the server offers (Kokoro: GET /v1/audio/voices). Falls back to the admin's list. */
export async function listVoices(fetchImpl: FetchLike, s: NarrationSettings): Promise<string[]> {
  const fallback = [...new Set([s.defaultVoice, ...(s.kidVoice ? [s.kidVoice] : []), ...s.voices])];
  if (!s.baseUrl) return fallback;
  try {
    const voices = await withTimeout(Math.min(s.timeoutMs, 8_000), async (signal) => {
      const res = await fetchImpl(`${s.baseUrl!.replace(/\/+$/, "")}/audio/voices`, { headers: headers(s), signal });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { voices?: unknown } | unknown[] | null;
      const list = Array.isArray(json) ? json : (json as { voices?: unknown } | null)?.voices;
      if (!Array.isArray(list)) return null;
      return list.map((v) => (typeof v === "string" ? v : (v as { id?: string; name?: string })?.id ?? (v as { name?: string })?.name)).filter((v): v is string => !!v);
    });
    if (voices?.length) return [...new Set([...fallback.filter((v) => voices.includes(v) || s.voices.includes(v)), ...voices])];
  } catch {
    /* server down: offer the configured list */
  }
  return fallback;
}

/** Test seam: forget which servers lacked captions. */
export function resetCaptionMemory() {
  noCaptions.clear();
}
