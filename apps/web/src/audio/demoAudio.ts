/**
 * Demo mode only: a few short, quiet music-box tunes made in the browser as WAV files, so the
 * player can be tried (and screenshotted) without an Audiobookshelf server.
 */
const RATE = 8000;
const NOTES = [523.25, 587.33, 659.25, 783.99, 880.0, 783.99, 659.25, 587.33];

export function makeDemoTrack(seconds: number, seed: number): string {
  const n = Math.floor(seconds * RATE);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8-bit
  str(36, "data");
  v.setUint32(40, n, true);
  const noteLen = RATE * 0.6;
  for (let i = 0; i < n; i++) {
    const note = NOTES[(Math.floor(i / noteLen) + seed) % NOTES.length]!;
    const t = (i % noteLen) / RATE;
    const env = Math.exp(-t * 4) * 0.25;
    v.setUint8(44 + i, 128 + Math.round(127 * env * Math.sin(2 * Math.PI * note * (i / RATE))));
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
