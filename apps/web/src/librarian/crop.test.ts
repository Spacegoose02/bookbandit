import { describe, expect, it } from "vitest";
import { clampPan, sourceRect } from "./crop";

describe("cover crop", () => {
  const base = { imgW: 1000, imgH: 1000, frameW: 200, frameH: 300, zoom: 1, dx: 0, dy: 0 };

  it("takes the centered 2:3 strip of a square image at zoom 1", () => {
    const r = sourceRect(base);
    expect(r.sh).toBeCloseTo(1000);
    expect(r.sw).toBeCloseTo(666.67, 1);
    expect(r.sx).toBeCloseTo(166.67, 1);
    expect(r.sy).toBeCloseTo(0);
  });

  it("zooms into the middle and pans, but never past the edge", () => {
    const z = sourceRect({ ...base, zoom: 2 });
    expect(z.sw).toBeCloseTo(333.33, 1);
    expect(z.sx).toBeCloseTo(333.33, 1);
    // Dragging the image right shows more of its left side.
    expect(sourceRect({ ...base, zoom: 2, dx: 50 }).sx).toBeLessThan(z.sx);
    expect(clampPan({ ...base, dx: 10_000, dy: 10_000 })).toEqual({ dx: 50, dy: 0 });
    expect(sourceRect({ ...base, dx: 10_000 }).sx).toBeCloseTo(0);
  });
});
