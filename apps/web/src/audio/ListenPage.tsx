import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { audioApi } from "./api";
import { BookmarksPanel } from "./Bookmarks";
import { pendingAudioProgress, saveAudioProgress } from "./progress";
import { chapterAt, formatTime, sleepLeft, sleepState, SPEEDS, type SleepTimer } from "./timeline";
import type { AudioBook, AudioPrefs } from "./types";
import { useAudioPlayer } from "./useAudioPlayer";
import "./audio.css";

const SAVE_EVERY_MS = 15_000;
const SLEEP_CHOICES = [5, 15, 30, 45, 60] as const;

/** Full audiobook player: /listen/:id */
export function ListenPage() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const [book, setBook] = useState<AudioBook | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setBook(null);
    setMissing(false);
    audioApi.audio(id).then(setBook, (e: unknown) => {
      if ((e instanceof ApiError && e.notFound) || (e as { notFound?: boolean }).notFound) setMissing(true);
      else setLoadError(e instanceof Error ? e.message : String(e));
    });
  }, [id]);

  if (missing)
    return (
      <BarnabyEmpty title="Barnaby can't find that audiobook">
        <Link className="bb-btn" to="/">
          Back to books
        </Link>
      </BarnabyEmpty>
    );
  if (loadError)
    return (
      <BarnabyEmpty title="The audiobook won't load">
        <p className="bb-muted">{loadError}</p>
      </BarnabyEmpty>
    );
  if (!book) return <div className="bb-page bb-muted">Loading…</div>;
  return <Player book={book} kid={!!me?.isKid} />;
}

function startPosition(book: AudioBook): number {
  const pending = pendingAudioProgress(book.bookId, book.progress?.clientUpdatedAt ?? null);
  const t = pending?.currentTime ?? book.progress?.currentTime ?? 0;
  // A finished book starts over.
  return book.progress?.finished && !pending ? 0 : t;
}

/** Speed and skip-silence for this book: the server's copy, else this device's, else defaults. */
function startPrefs(book: AudioBook): AudioPrefs {
  if (book.prefs) return book.prefs;
  try {
    const raw = localStorage.getItem(`bb-audio-prefs-${book.bookId}`);
    if (raw) return { speed: 1, skipSilence: false, ...(JSON.parse(raw) as Partial<AudioPrefs>) };
  } catch {
    /* ignore */
  }
  return { speed: 1, skipSilence: false };
}

function savePrefs(bookId: string, prefs: Partial<AudioPrefs>) {
  try {
    const raw = localStorage.getItem(`bb-audio-prefs-${bookId}`);
    localStorage.setItem(`bb-audio-prefs-${bookId}`, JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), ...prefs }));
  } catch {
    /* ignore */
  }
  audioApi.putPrefs(bookId, prefs).catch(() => undefined); // offline: this device still remembers
}

function Player({ book, kid }: { book: AudioBook; kid: boolean }) {
  const navigate = useNavigate();
  const start = useMemo(() => startPosition(book), [book]);
  const initialPrefs = useMemo(() => startPrefs(book), [book]);
  const [skipSilence, setSkipSilence] = useState(initialPrefs.skipSilence);
  const p = useAudioPlayer(book.tracks, start, { skipSilence });
  const [sleep, setSleep] = useState<SleepTimer>({ kind: "off" });
  const [panel, setPanel] = useState<"none" | "chapters" | "speed" | "sleep" | "bookmarks">("none");
  const [bookmarkCount, setBookmarkCount] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [scrub, setScrub] = useState<number | null>(null);
  const chapterIdx = chapterAt(book.chapters, p.time);
  const chapter = book.chapters[chapterIdx];

  // Speed is remembered per book.
  useEffect(() => {
    p.setRate(initialPrefs.speed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrefs]);
  const changeRate = (r: number) => {
    p.setRate(r);
    savePrefs(book.bookId, { speed: r });
  };
  const toggleSkipSilence = () => {
    setSkipSilence(!skipSilence);
    savePrefs(book.bookId, { skipSilence: !skipSilence });
  };

  // --- progress sync --------------------------------------------------------
  const save = useRef((opts?: { keepalive?: boolean }) => {
    void saveAudioProgress(audioApi, book.bookId, p.now(), book.duration, opts);
  });
  save.current = (opts) => void saveAudioProgress(audioApi, book.bookId, p.now(), book.duration, { ...opts, finished: p.ended || undefined });

  useEffect(() => {
    if (!p.playing) return;
    const t = setInterval(() => save.current(), SAVE_EVERY_MS);
    return () => clearInterval(t);
  }, [p.playing]);
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (wasPlaying.current && !p.playing) save.current();
    wasPlaying.current = p.playing;
  }, [p.playing]);
  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && save.current({ keepalive: true });
    const pagehide = () => save.current({ keepalive: true });
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", pagehide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", pagehide);
      save.current({ keepalive: true });
    };
  }, []);

  // --- sleep timer ----------------------------------------------------------
  useEffect(() => {
    if (sleep.kind === "off") {
      p.setVolume(1);
      return;
    }
    const t = setInterval(() => {
      const now = Date.now();
      setClock(now);
      const s = sleepState(sleep, now, p.now(), p.rate);
      p.setVolume(s.volume);
      if (s.stop) {
        p.pause();
        p.setVolume(1);
        setSleep({ kind: "off" });
      }
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleep, p.rate]);

  // --- lock screen / headset controls ----------------------------------------
  const pRef = useRef(p);
  pRef.current = p;
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: book.author ?? undefined,
      album: chapter?.title,
      artwork: book.coverUrl ? [{ src: book.coverUrl }] : [],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => void pRef.current.play());
    ms.setActionHandler("pause", () => pRef.current.pause());
    ms.setActionHandler("seekbackward", () => pRef.current.skip(-30));
    ms.setActionHandler("seekforward", () => pRef.current.skip(30));
    return () => {
      for (const a of ["play", "pause", "seekbackward", "seekforward"] as const) ms.setActionHandler(a, null);
    };
  }, [book, chapter?.title]);

  const sleepLabel = (() => {
    const left = sleepLeft(sleep, clock, p.time, p.rate);
    return left == null ? "Sleep" : formatTime(left);
  })();
  const shown = scrub ?? p.time;

  return (
    <div className={`bb-page bb-listen${kid ? " is-kid" : ""}`}>
      <button className="bb-btn bb-btn-ghost bb-listen-back" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <div className="bb-listen-main">
        <div className="bb-listen-cover">
          {book.coverUrl ? <img src={book.coverUrl} alt="" /> : <div className="bb-cover bb-cover-blank">{book.title}</div>}
        </div>
        <div className="bb-listen-info">
          <h1 className="bb-h1">{book.title}</h1>
          <p className="bb-muted">
            {book.author}
            {book.narrator ? ` · read by ${book.narrator}` : ""}
          </p>
          {book.source && !kid && (
            <p className="bb-muted bb-small bb-listen-source">{book.source === "local" ? "From your audiobook folder" : "From Audiobookshelf"}</p>
          )}
          {chapter && (
            <button className="bb-listen-chapter" onClick={() => setPanel(panel === "chapters" ? "none" : "chapters")}>
              {chapter.title}
              <span aria-hidden> ▾</span>
            </button>
          )}

          <div className="bb-listen-scrub">
            <input
              type="range"
              className="bb-slider"
              min={0}
              max={Math.max(1, book.duration)}
              step={1}
              value={shown}
              aria-label="Position"
              aria-valuetext={formatTime(shown)}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={() => scrub != null && (p.seek(scrub), setScrub(null))}
              onKeyUp={() => scrub != null && (p.seek(scrub), setScrub(null))}
            />
            <div className="bb-listen-times">
              <span>{formatTime(shown)}</span>
              <span>-{formatTime(book.duration - shown)}</span>
            </div>
          </div>

          <div className="bb-listen-controls">
            <button className="bb-listen-skip" onClick={() => p.skip(-30)} aria-label="Back 30 seconds">
              <span aria-hidden>↺</span>
              <small>30</small>
            </button>
            <button
              className={`bb-listen-play${p.loading && p.playing ? " is-loading" : ""}`}
              onClick={p.toggle}
              aria-label={p.playing ? "Pause" : "Play"}
            >
              {p.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="bb-listen-skip" onClick={() => p.skip(30)} aria-label="Forward 30 seconds">
              <span aria-hidden>↻</span>
              <small>30</small>
            </button>
          </div>

          <div className="bb-listen-tools">
            <button className="bb-btn" aria-expanded={panel === "speed"} onClick={() => setPanel(panel === "speed" ? "none" : "speed")}>
              {p.rate}×
            </button>
            <button className={`bb-btn${skipSilence ? " bb-btn-primary" : ""}`} aria-pressed={skipSilence} onClick={toggleSkipSilence} title="Play quiet gaps faster">
              <span aria-hidden>{p.skipping ? "⏩" : "🤫"}</span> Skip silence
            </button>
            <button className="bb-btn" aria-expanded={panel === "bookmarks"} onClick={() => setPanel(panel === "bookmarks" ? "none" : "bookmarks")}>
              <span aria-hidden>🔖</span> Bookmarks{bookmarkCount ? ` (${bookmarkCount})` : ""}
            </button>
            <button
              className={`bb-btn${sleep.kind !== "off" ? " bb-btn-primary" : ""}`}
              aria-expanded={panel === "sleep"}
              onClick={() => setPanel(panel === "sleep" ? "none" : "sleep")}
            >
              <span aria-hidden>🌙</span> {sleepLabel}
            </button>
            {book.chapters.length > 0 && (
              <button className="bb-btn" aria-expanded={panel === "chapters"} onClick={() => setPanel(panel === "chapters" ? "none" : "chapters")}>
                Chapters
              </button>
            )}
          </div>
          {p.error && <p className="bb-error">{p.error}</p>}

          {panel === "speed" && (
            <div className="bb-listen-panel" role="radiogroup" aria-label="Speed">
              {SPEEDS.map((s) => (
                <button key={s} role="radio" aria-checked={p.rate === s} className="bb-chip" onClick={() => (changeRate(s), setPanel("none"))}>
                  {s}×
                </button>
              ))}
            </div>
          )}
          {panel === "sleep" && (
            <div className="bb-listen-panel" aria-label="Sleep timer">
              {SLEEP_CHOICES.map((m) => (
                <button
                  key={m}
                  className="bb-chip"
                  aria-pressed={sleep.kind === "minutes" && sleep.minutes === m}
                  onClick={() => (setSleep({ kind: "minutes", minutes: m, endsAt: Date.now() + m * 60_000 }), setClock(Date.now()), setPanel("none"))}
                >
                  {m} min
                </button>
              ))}
              {chapter && (
                <button
                  className="bb-chip"
                  aria-pressed={sleep.kind === "chapter"}
                  onClick={() => (setSleep({ kind: "chapter", chapterEnd: chapter.end }), setPanel("none"))}
                >
                  End of chapter
                </button>
              )}
              <button className="bb-chip" aria-pressed={sleep.kind === "off"} onClick={() => (setSleep({ kind: "off" }), setPanel("none"))}>
                Off
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Kept mounted (hidden) so the count on the button stays right. */}
      <div hidden={panel !== "bookmarks"}>
        <BookmarksPanel api={audioApi} bookId={book.bookId} now={p.now} onSeek={p.seek} onCount={setBookmarkCount} />
      </div>

      {panel === "chapters" && (
        <ol className="bb-listen-chapters" aria-label="Chapters">
          {book.chapters.map((c, i) => (
            <li key={i}>
              <button aria-current={i === chapterIdx ? "true" : undefined} onClick={() => p.seek(c.start)}>
                <span>{c.title}</span>
                <span className="bb-muted">{formatTime(c.start)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function PlayIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="6" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" />
    </svg>
  );
}
