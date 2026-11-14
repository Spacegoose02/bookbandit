/**
 * Reads the open book aloud in the reader and moves a highlight along word by word.
 *
 * Three ways to speak, best first:
 * - "overlay": the book's own recorded narrator (EPUB3 media overlays), played by foliate-js.
 * - "server": the family's speech server (Kokoro or Piper) through /api/narration/speech, one
 *   chunk of sentences at a time with the next chunk fetched while this one plays.
 * - "browser": the device's built-in voice (speechSynthesis), with its word-boundary events.
 *
 * foliate-js hands us one block of text at a time as SSML with a <mark> before every word, and
 * `tts.setMark(name)` highlights that word (turning the page when needed).
 */
import type { FoliateView } from "foliate-js/view.js";
import { readAloudApi, type Clip } from "./api";
import { chunkText, markAt, parseSsml, wordSchedule, type Block, type Chunk } from "./ssml";

export type NarrationMode = "overlay" | "server" | "browser";
export type NarratorState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

interface Tts {
  start(): string | undefined;
  next(paused?: boolean): string | undefined;
  from(range: Range): string | undefined;
  setMark(mark: string): void;
}

interface MediaOverlay extends EventTarget {
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(r: number): void;
}

export interface NarratedView extends FoliateView {
  initTTS(granularity?: "word" | "sentence"): Promise<void>;
  tts: Tts | null;
  mediaOverlay?: MediaOverlay | null;
  startMediaOverlay?(): Promise<void>;
  book: FoliateView["book"] & { sections?: { id: string; linear?: string }[]; media?: { activeClass?: string } };
  lastLocation: FoliateView["lastLocation"] & { range?: Range };
  renderer: FoliateView["renderer"] & {
    nextSection?: () => Promise<void>;
    getContents?: () => { doc: Document; index: number }[];
  };
}

export interface NarratorOptions {
  bookId: string;
  mode: NarrationMode;
  /** Browser voice speed (the server voice's speed is set per person on the server). */
  rate?: number;
  lang?: string;
  onState(state: NarratorState, detail?: string): void;
  /** A section finished and reading moved on to the next one (quiz time). */
  onSectionEnd?(index: number): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function sectionIndex(view: NarratedView): number | null {
  return view.renderer.getContents?.()[0]?.index ?? null;
}

export class Narrator {
  private alive = true;
  private paused = false;
  private wake: (() => void) | null = null;
  private audio: HTMLAudioElement | null = null;
  private clips = new Map<string, Promise<Clip>>();
  private raf = 0;

  constructor(
    private view: NarratedView,
    private opts: NarratorOptions,
  ) {}

  start() {
    this.opts.onState("loading");
    if (this.opts.mode === "overlay") return void this.startOverlay();
    this.run().catch((e: Error) => {
      if (this.alive) this.opts.onState("error", e.message);
    });
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.opts.mode === "overlay") this.view.mediaOverlay?.pause();
    this.audio?.pause();
    if (this.opts.mode === "browser") speechSynthesis.cancel();
    this.opts.onState("paused");
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.opts.mode === "overlay") this.view.mediaOverlay?.resume();
    void this.audio?.play().catch(() => undefined);
    this.wake?.();
    this.wake = null;
    this.opts.onState("playing");
  }

  stop() {
    this.alive = false;
    this.paused = false;
    cancelAnimationFrame(this.raf);
    this.wake?.();
    if (this.opts.mode === "overlay") this.view.mediaOverlay?.stop();
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    if (this.opts.mode === "browser" && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  get isPaused() {
    return this.paused;
  }

  // --- media overlays --------------------------------------------------------
  private async startOverlay() {
    const mo = this.view.mediaOverlay;
    if (!mo || !this.view.startMediaOverlay) return this.opts.onState("error", "This book has no recorded narration");
    mo.setRate(this.opts.rate ?? 1);
    mo.addEventListener("error", () => this.alive && this.opts.onState("error", "The narration audio didn't load"));
    await this.view.startMediaOverlay();
    if (this.alive) this.opts.onState("playing");
  }

  // --- synthetic voices ------------------------------------------------------
  private waitWhilePaused() {
    return this.paused ? new Promise<void>((r) => (this.wake = r)) : Promise.resolve();
  }

  private async run() {
    const v = this.view;
    await v.initTTS("word");
    const here = v.lastLocation?.range;
    let ssml = (here ? v.tts?.from(here) : undefined) ?? v.tts?.start();
    let section = sectionIndex(v);
    while (this.alive) {
      await this.waitWhilePaused();
      if (!this.alive) return;
      if (!ssml) {
        // End of this section: on to the next one.
        const before = section;
        if (typeof v.renderer.nextSection === "function") await v.renderer.nextSection();
        else await v.next();
        await sleep(250);
        section = sectionIndex(v);
        if (section === before) {
          this.opts.onState("ended");
          return;
        }
        if (before != null) this.opts.onSectionEnd?.(before);
        await this.waitWhilePaused();
        await v.initTTS("word");
        ssml = v.tts?.start();
        continue;
      }
      const block = parseSsml(ssml);
      if (block.text) await this.speakBlock(block);
      if (!this.alive) return;
      ssml = v.tts?.next();
    }
  }

  private async speakBlock(block: Block) {
    const chunks = chunkText(block.text, this.opts.mode === "server" ? 280 : 400);
    for (let i = 0; i < chunks.length && this.alive; i++) {
      if (this.opts.mode === "server") {
        if (chunks[i + 1]) void this.clip(chunks[i + 1]!.text).catch(() => undefined);
        await this.playServer(block, chunks[i]!);
      } else await this.playBrowser(block, chunks[i]!);
    }
  }

  private clip(text: string): Promise<Clip> {
    let p = this.clips.get(text);
    if (!p) {
      p = readAloudApi.speech(this.opts.bookId, text);
      this.clips.set(text, p);
      p.catch(() => this.clips.delete(text));
      if (this.clips.size > 40) this.clips.delete(this.clips.keys().next().value!);
    }
    return p;
  }

  private async playServer(block: Block, chunk: Chunk) {
    const clip = await this.clip(chunk.text);
    if (!this.alive) return;
    const audio = (this.audio ??= new Audio());
    audio.src = clip.url;
    audio.playbackRate = 1;
    await new Promise<void>((resolve, reject) => {
      let schedule: { name: string; at: number }[] = [];
      let last: string | null = null;
      const tick = () => {
        if (!this.alive) return;
        const name = markAt(schedule, audio.currentTime);
        if (name && name !== last) {
          last = name;
          this.view.tts?.setMark(name);
        }
        this.raf = requestAnimationFrame(tick);
      };
      audio.onloadedmetadata = () => {
        schedule = wordSchedule(chunk, block.marks, clip.words, audio.duration);
      };
      audio.onplaying = () => {
        if (!schedule.length) schedule = wordSchedule(chunk, block.marks, clip.words, audio.duration);
        this.opts.onState("playing");
        cancelAnimationFrame(this.raf);
        this.raf = requestAnimationFrame(tick);
      };
      audio.onended = () => {
        cancelAnimationFrame(this.raf);
        resolve();
      };
      audio.onerror = () => {
        cancelAnimationFrame(this.raf);
        if (!this.alive) resolve();
        else reject(new Error("Couldn't play the narration"));
      };
      const go = () => {
        if (!this.alive) return resolve();
        if (this.paused) {
          this.wake = go;
          return;
        }
        audio.play().catch((e: Error) => {
          // Autoplay blocked or a stop() in between.
          if (!this.alive) resolve();
          else reject(e);
        });
      };
      go();
    });
  }

  private async playBrowser(block: Block, chunk: Chunk) {
    for (;;) {
      await this.waitWhilePaused();
      if (!this.alive) return;
      const done = await new Promise<boolean>((resolve) => {
        const u = new SpeechSynthesisUtterance(chunk.text);
        const voice = pickVoice(this.opts.lang ?? "en");
        if (voice) u.voice = voice;
        u.lang = voice?.lang ?? this.opts.lang ?? "en";
        u.rate = this.opts.rate ?? 0.95;
        const marks = block.marks.filter((m) => m.offset >= chunk.start && m.offset < chunk.end);
        u.onstart = () => {
          this.opts.onState("playing");
          if (marks[0]) this.view.tts?.setMark(marks[0].name);
        };
        u.onboundary = (e) => {
          if (e.name && e.name !== "word") return;
          const at = chunk.start + e.charIndex;
          const m = [...marks].reverse().find((x) => x.offset <= at);
          if (m) this.view.tts?.setMark(m.name);
        };
        u.onend = () => resolve(true);
        u.onerror = () => resolve(false);
        speechSynthesis.speak(u);
      });
      if (done || !this.alive) return;
      // Cancelled by pause: say this chunk again after resuming.
    }
  }
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  const base = lang.slice(0, 2).toLowerCase();
  const same = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  return same.find((v) => v.default) ?? same.find((v) => v.localService) ?? same[0] ?? null;
}

export function browserVoiceAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Say one word (or a few) with the server voice when there is one, else the device voice. */
export async function sayWord(text: string, opts: { bookId?: string; server: boolean; slow?: boolean }): Promise<void> {
  if (opts.server && opts.bookId) {
    try {
      const clip = await readAloudApi.speech(opts.bookId, text);
      const a = new Audio(clip.url);
      a.playbackRate = opts.slow ? 0.75 : 1;
      await a.play();
      return;
    } catch {
      /* fall back to the device voice */
    }
  }
  if (!browserVoiceAvailable()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = opts.slow ? 0.6 : 0.9;
  speechSynthesis.speak(u);
}
