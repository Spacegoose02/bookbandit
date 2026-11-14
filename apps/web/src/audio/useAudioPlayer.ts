import { useCallback, useEffect, useRef, useState } from "react";
import { locate, totalDuration } from "./timeline";
import type { AudioTrack } from "./types";

export interface AudioPlayer {
  /** Seconds into the whole book. */
  time: number;
  duration: number;
  playing: boolean;
  /** Reached the end of the last track. */
  ended: boolean;
  /** Waiting for audio data. */
  loading: boolean;
  error: string | null;
  rate: number;
  play(): Promise<void>;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  skip(seconds: number): void;
  setRate(rate: number): void;
  setVolume(v: number): void;
  /** Current time without waiting for a re-render (for timers and progress saves). */
  now(): number;
}

/**
 * One <audio> element playing a multi-track audiobook as if it were a single file.
 * Tracks are switched on `ended`, and seeks across tracks load the right file.
 */
export function useAudioPlayer(tracks: AudioTrack[] | null, startAt = 0): AudioPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef(0);
  const timeRef = useRef(startAt);
  const rateRef = useRef(1);
  const [time, setTime] = useState(startAt);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(1);
  const duration = tracks ? totalDuration(tracks) : 0;

  const load = useCallback(
    (index: number, offset: number, autoplay: boolean) => {
      const audio = audioRef.current;
      const track = tracks?.[index];
      if (!audio || !track) return;
      trackRef.current = index;
      if (audio.dataset.src !== track.url) {
        audio.dataset.src = track.url;
        audio.src = track.url;
        setLoading(true);
      }
      const apply = () => {
        audio.currentTime = offset;
        audio.playbackRate = rateRef.current;
        if (autoplay) audio.play().catch((e: Error) => e.name !== "AbortError" && setError(e.message));
      };
      if (audio.readyState >= 1) apply();
      else audio.addEventListener("loadedmetadata", apply, { once: true });
    },
    [tracks],
  );

  useEffect(() => {
    if (!tracks?.length) return;
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;
    const onTime = () => {
      const t = (tracks[trackRef.current]?.startOffset ?? 0) + audio.currentTime;
      timeRef.current = t;
      setTime(t);
    };
    const onEnded = () => {
      const next = trackRef.current + 1;
      if (next < tracks.length) load(next, 0, true);
      else {
        setPlaying(false);
        setEnded(true);
      }
    };
    const on = (type: string, fn: () => void) => audio.addEventListener(type, fn);
    on("timeupdate", onTime);
    on("ended", onEnded);
    on("play", () => (setPlaying(true), setEnded(false), setError(null)));
    on("pause", () => setPlaying(false));
    on("waiting", () => setLoading(true));
    on("canplay", () => setLoading(false));
    on("playing", () => setLoading(false));
    on("error", () => {
      setLoading(false);
      setPlaying(false);
      setError("This audiobook couldn't be played.");
    });
    const start = locate(tracks, timeRef.current);
    load(start.index, start.offset, false);
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    };
  }, [tracks, load]);

  const seek = useCallback(
    (t: number) => {
      if (!tracks?.length) return;
      const clamped = Math.max(0, Math.min(t, totalDuration(tracks)));
      const loc = locate(tracks, clamped);
      const audio = audioRef.current;
      timeRef.current = clamped;
      setTime(clamped);
      setEnded(false);
      if (!audio) return;
      if (loc.index === trackRef.current && audio.readyState >= 1) audio.currentTime = loc.offset;
      else load(loc.index, loc.offset, !audio.paused);
    },
    [tracks, load],
  );

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (ended) seek(0);
    try {
      await audio.play();
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    }
  }, [ended, seek]);

  const pause = useCallback(() => audioRef.current?.pause(), []);

  return {
    time,
    duration,
    playing,
    ended,
    loading,
    error,
    rate,
    play,
    pause,
    toggle: () => (audioRef.current?.paused ? void play() : pause()),
    seek,
    skip: (s) => seek(timeRef.current + s),
    setRate: (r) => {
      rateRef.current = r;
      setRateState(r);
      if (audioRef.current) audioRef.current.playbackRate = r;
    },
    setVolume: (v) => {
      if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, v));
    },
    now: () => timeRef.current,
  };
}
