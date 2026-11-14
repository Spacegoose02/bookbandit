import { useEffect, useRef } from "react";
import type { StorytellerTonight } from "@bookbandit/shared";
import { storytellerApi, type StartedStory } from "./api";

/**
 * Keeps the server's clock running for a story: a heartbeat every `beatIntervalMs`, one right
 * away whenever play/pause flips (so paused time isn't counted), and an "end" when the story
 * closes. The server answers `stop` once tonight's minutes are gone.
 */
export function useStorySession(
  started: StartedStory | null,
  playing: boolean,
  onStop: (tonight: StorytellerTonight) => void,
): { finish(completed: boolean): Promise<StorytellerTonight | null> } {
  const playingRef = useRef(playing);
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  const endedRef = useRef(false);
  const beatRef = useRef<((wasPlaying: boolean) => Promise<unknown>) | null>(null);
  const id = started?.session.id ?? null;

  useEffect(() => {
    endedRef.current = false;
    if (!id || !started) return;
    const beat = (wasPlaying: boolean) =>
      storytellerApi.beat(id, wasPlaying).then(
        (r) => r.stop && !endedRef.current && onStopRef.current(r.tonight),
        () => undefined, // offline: the next beat catches up (capped by the server)
      );
    const t = setInterval(() => void beat(playingRef.current), started.beatIntervalMs);
    const onHide = () => {
      if (!endedRef.current) void storytellerApi.end(id, { playing: playingRef.current, completed: false }, true);
    };
    window.addEventListener("pagehide", onHide);
    beatRef.current = beat;
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", onHide);
      if (!endedRef.current) {
        endedRef.current = true;
        void storytellerApi.end(id, { playing: playingRef.current, completed: false }, true).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (playingRef.current === playing) return;
    const was = playingRef.current;
    playingRef.current = playing;
    // Credit up to the pause, or restart the clock without credit on play.
    void beatRef.current?.(was);
  }, [playing]);

  return {
    async finish(completed) {
      if (!id || endedRef.current) return null;
      endedRef.current = true;
      try {
        return (await storytellerApi.end(id, { playing: playingRef.current, completed })).tonight;
      } catch {
        return null;
      }
    },
  };
}
