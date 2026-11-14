/**
 * Text-to-speech fallback for picture books with no audiobook: foliate-js finds the text block
 * by block, the family's speech server (Kokoro/Piper, see ../readaloud) or else the browser's
 * speechSynthesis reads it, and the page turns as the story goes.
 * Pages with no words (pure pictures) stay up for a few seconds before turning.
 */
import type { FoliateView } from "foliate-js/view.js";
import { readAloudApi } from "../readaloud/api";

const PICTURE_PAGE_MS = 6_000;

export function ssmlToText(ssml: string): string {
  try {
    const doc = new DOMParser().parseFromString(ssml, "application/xml");
    return (doc.documentElement.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return ssml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
}

export function readAloudSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** A friendly voice for the book's language, preferring the device's default/local ones. */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  const base = lang.slice(0, 2).toLowerCase();
  const same = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  return same.find((v) => v.default) ?? same.find((v) => v.localService) ?? same[0] ?? null;
}

interface TtsView extends FoliateView {
  initTTS(granularity?: "word" | "sentence"): Promise<void>;
  tts: { start(): string | undefined; next(paused?: boolean): string | undefined; resume(): string | undefined } | null;
  renderer: FoliateView["renderer"] & { nextSection?: () => Promise<void> };
}

export interface ReadAloudController {
  pause(): void;
  resume(): void;
  stop(): void;
}

/**
 * Read `view` aloud from where it is. `onEnd` fires after the last page.
 * Pausing cancels the current sentence block; resuming starts that block again.
 */
export function startReadAloud(
  view: FoliateView,
  opts: { lang?: string; rate?: number; bookId?: string; onEnd(): void; onPageWithoutWords?(): void },
): ReadAloudController {
  const v = view as TtsView;
  let alive = true;
  let paused = false;
  let wake: (() => void) | null = null;
  let current = "";

  const waitWhilePaused = () =>
    paused ? new Promise<void>((r) => (wake = r)) : Promise.resolve();

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // The server voice, when an admin set one up (ws/readaloud). Cached clips make re-reads instant.
  let server: Promise<boolean> = opts.bookId
    ? readAloudApi.status(opts.bookId).then((s) => s.server, () => false)
    : Promise.resolve(false);
  let audio: HTMLAudioElement | null = null;
  let stopAudio: (() => void) | null = null;

  async function speakServer(text: string): Promise<boolean | null> {
    if (!opts.bookId || !(await server)) return null;
    let url: string;
    try {
      url = (await readAloudApi.speech(opts.bookId, text)).url;
    } catch {
      server = Promise.resolve(false); // fall back to the device voice for the rest of the story
      return null;
    }
    if (!alive || paused) return false;
    return new Promise((resolve) => {
      const a = (audio ??= new Audio());
      a.src = url;
      a.onended = () => resolve(true);
      a.onerror = () => resolve(false);
      stopAudio = () => {
        a.pause();
        resolve(false);
      };
      a.play().catch(() => resolve(false));
    });
  }

  async function speak(text: string): Promise<boolean> {
    const viaServer = await speakServer(text);
    if (viaServer !== null) return viaServer;
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickVoice(opts.lang ?? "en");
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? opts.lang ?? "en";
      u.rate = opts.rate ?? 0.9;
      u.pitch = 1.05;
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false); // cancelled by pause/stop
      speechSynthesis.speak(u);
    });
  }

  const where = () => `${v.lastLocation?.cfi ?? ""}|${v.lastLocation?.fraction ?? ""}`;

  async function turnPage(): Promise<boolean> {
    const before = where();
    if (typeof v.renderer.nextSection === "function") await v.renderer.nextSection();
    else await v.next();
    await sleep(300);
    return where() !== before;
  }

  (async () => {
    await v.initTTS("sentence");
    let ssml = v.tts?.start();
    let spokeOnPage = false;
    while (alive) {
      await waitWhilePaused();
      if (!alive) break;
      if (!ssml) {
        if (!spokeOnPage) {
          opts.onPageWithoutWords?.();
          await sleep(PICTURE_PAGE_MS);
          await waitWhilePaused();
          if (!alive) break;
        }
        if (!(await turnPage())) {
          if (alive) opts.onEnd();
          return;
        }
        await v.initTTS("sentence");
        ssml = v.tts?.start();
        spokeOnPage = false;
        continue;
      }
      current = ssmlToText(ssml);
      if (current) {
        const done = await speak(current);
        if (!done) continue; // paused or stopped: say this block again after resuming
        spokeOnPage = true;
      }
      ssml = v.tts?.next(true);
    }
  })().catch(() => alive && opts.onEnd());

  return {
    pause() {
      paused = true;
      stopAudio?.();
      speechSynthesis.cancel();
    },
    resume() {
      paused = false;
      wake?.();
      wake = null;
    },
    stop() {
      alive = false;
      paused = false;
      wake?.();
      stopAudio?.();
      speechSynthesis.cancel();
    },
  };
}
