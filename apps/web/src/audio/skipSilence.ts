/**
 * Skip silence: while the narrator pauses, play faster, then drop back to the chosen speed as
 * soon as there's sound again. Listens to the <audio> element through a Web Audio analyser
 * (tracks come from our own server, so the element isn't cross-origin and can be analysed).
 *
 * Once an element is routed through Web Audio it stays routed (the browser offers no way back),
 * so turning the option off only stops changing the speed.
 */

/** RMS below this counts as silence (about -40 dBFS). */
export const SILENCE_RMS = 0.01;
/** Silence must last this long before speeding up, so short pauses between words stay natural. */
export const SILENCE_HOLD_MS = 300;
/** How much faster silence plays, capped so pitch artefacts stay mild. */
export const SILENCE_SPEEDUP = 3;
export const MAX_SILENCE_RATE = 4;

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Tracks how long it has been quiet; `silent` turns on after the hold time and off at once. */
export class SilenceDetector {
  private quietSince: number | null = null;

  update(level: number, now: number): boolean {
    if (level >= SILENCE_RMS) {
      this.quietSince = null;
      return false;
    }
    this.quietSince ??= now;
    return now - this.quietSince >= SILENCE_HOLD_MS;
  }

  reset() {
    this.quietSince = null;
  }
}

export function silenceRate(baseRate: number, silent: boolean): number {
  return silent ? Math.min(MAX_SILENCE_RATE, Math.max(baseRate, baseRate * SILENCE_SPEEDUP)) : baseRate;
}

type Graph = { ctx: AudioContext; analyser: AnalyserNode };
const graphs = new WeakMap<HTMLAudioElement, Graph>();

function graphFor(audio: HTMLAudioElement): Graph | null {
  const existing = graphs.get(audio);
  if (existing) return existing;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const g = { ctx, analyser };
    graphs.set(audio, g);
    return g;
  } catch {
    return null;
  }
}

/**
 * Starts adjusting `audio`'s speed around silences. `baseRate` is read on every tick so speed
 * changes apply at once; `onChange` reports whether silence is being skipped right now.
 * Returns a stop function that puts the base speed back.
 */
export function startSkipSilence(audio: HTMLAudioElement, baseRate: () => number, onChange: (skipping: boolean) => void): () => void {
  const g = graphFor(audio);
  if (!g) return () => undefined;
  const buf = new Float32Array(g.analyser.fftSize);
  const detector = new SilenceDetector();
  let skipping = false;
  const tick = () => {
    if (audio.paused) {
      detector.reset();
      return;
    }
    if (g.ctx.state === "suspended") void g.ctx.resume();
    g.analyser.getFloatTimeDomainData(buf);
    const silent = detector.update(rms(buf), performance.now());
    const rate = silenceRate(baseRate(), silent);
    if (Math.abs(audio.playbackRate - rate) > 0.01) audio.playbackRate = rate;
    if (silent !== skipping) {
      skipping = silent;
      onChange(silent);
    }
  };
  const timer = window.setInterval(tick, 50);
  return () => {
    window.clearInterval(timer);
    audio.playbackRate = baseRate();
    if (skipping) onChange(false);
  };
}

/** Call from a click (play): browsers only let audio contexts start after a user gesture. */
export function resumeSkipSilence(audio: HTMLAudioElement | null) {
  const g = audio ? graphs.get(audio) : undefined;
  if (g && g.ctx.state === "suspended") void g.ctx.resume();
}
