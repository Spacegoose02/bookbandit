import { describe, expect, it, vi } from "vitest";
import { IDLE_AFTER_MS, ReadingTimer, TICK_MS, type TimerEnv } from "./readingTimer";
import type { ReadingHeartbeat } from "../api/client";

function setup(visible = true) {
  let t = 1_000_000;
  let fn: (() => void) | null = null;
  const env: TimerEnv = {
    now: () => t,
    visible: () => visible,
    setInterval: (f) => ((fn = f), 1),
    clearInterval: () => undefined,
  };
  const api = { readingHeartbeat: vi.fn(async (_beat: ReadingHeartbeat, _opts?: { keepalive?: boolean }) => undefined) };
  const timer = new ReadingTimer(api, "b1", { env, deviceName: "Tablet" });
  const advance = (ms: number) => {
    for (let i = 0; i < ms / TICK_MS; i++) {
      t += TICK_MS;
      fn?.();
    }
  };
  return { timer, api, advance, touch: () => timer.touch(), setVisible: (v: boolean) => (visible = v) };
}

describe("ReadingTimer", () => {
  it("reports about a minute of active reading each minute", async () => {
    const { api, advance } = setup();
    advance(60_000);
    await Promise.resolve();
    expect(api.readingHeartbeat).toHaveBeenCalledTimes(1);
    expect(api.readingHeartbeat.mock.calls[0]![0]).toMatchObject({ bookId: "b1", seconds: 60, kind: "read", deviceName: "Tablet" });
  });

  it("stops counting after the reader goes idle", async () => {
    const { api, advance, timer } = setup();
    advance(IDLE_AFTER_MS + 2 * 60_000);
    await timer.flush();
    const total = api.readingHeartbeat.mock.calls.reduce((n, c) => n + c[0].seconds, 0);
    expect(total).toBe(IDLE_AFTER_MS / 1000);
  });

  it("doesn't count a hidden tab", async () => {
    const { api, advance, timer } = setup(false);
    advance(120_000);
    await timer.flush();
    expect(api.readingHeartbeat).not.toHaveBeenCalled();
  });

  it("keeps time for later when sending fails", async () => {
    const { api, advance, timer } = setup();
    api.readingHeartbeat.mockRejectedValueOnce(new Error("offline"));
    advance(60_000);
    await Promise.resolve();
    await Promise.resolve();
    advance(60_000);
    await timer.flush();
    const last = api.readingHeartbeat.mock.calls.at(-1)![0];
    expect(last.seconds).toBe(120);
  });
});
