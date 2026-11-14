import { describe, expect, it } from "vitest";
import { MAX_SILENCE_RATE, rms, SILENCE_HOLD_MS, SilenceDetector, silenceRate } from "./skipSilence";

describe("skip silence", () => {
  it("measures loudness", () => {
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });

  it("waits out short pauses and stops skipping as soon as there's sound", () => {
    const d = new SilenceDetector();
    expect(d.update(0.001, 0)).toBe(false);
    expect(d.update(0.001, SILENCE_HOLD_MS - 1)).toBe(false); // a pause between words
    expect(d.update(0.001, SILENCE_HOLD_MS)).toBe(true);
    expect(d.update(0.2, SILENCE_HOLD_MS + 50)).toBe(false);
    expect(d.update(0.001, SILENCE_HOLD_MS + 60)).toBe(false); // the hold starts over
  });

  it("speeds up silence from the chosen speed, within a cap", () => {
    expect(silenceRate(1, false)).toBe(1);
    expect(silenceRate(1, true)).toBe(3);
    expect(silenceRate(2, true)).toBe(MAX_SILENCE_RATE);
  });
});
