import { useEffect, useMemo, useRef, useState } from "react";
import type { StorytellerTonight } from "@bookbandit/shared";
import { api } from "../api/client";
import { BarnabyAvatar } from "../brand/Barnaby";
import { audioApi } from "../audio/api";
import { PauseIcon, PlayIcon } from "../audio/ListenPage";
import { saveAudioProgress } from "../audio/progress";
import { sleepState } from "../audio/timeline";
import type { AudioBook } from "../audio/types";
import { useAudioPlayer } from "../audio/useAudioPlayer";
import { pickReadableFile } from "../reader/formats";
import type { FoliateView } from "foliate-js/view.js";
import type { StartedStory, Story } from "./api";
import { startReadAloud, type ReadAloudController } from "./readAloud";
import { StoryCover } from "./StoryCover";
import { useStorySession } from "./useStorySession";

interface Props {
  story: Story;
  started: StartedStory;
  sleepEndsAt: number | null;
  /** The story ended (completed) or the kid went back to the covers. */
  onDone(tonight: StorytellerTonight | null, completed: boolean): void;
  /** The server says tonight's minutes are used up. */
  onGoodnight(tonight: StorytellerTonight): void;
  /** The bedtime sleep timer ran out. */
  onSleep(): void;
}

export function StoryPlayer(props: Props) {
  return props.started.session.mode === "audio" ? <AudioStory {...props} /> : <ReadAloudStory {...props} />;
}

function Shell({
  story,
  playing,
  onToggle,
  onHome,
  children,
}: {
  story: Story;
  playing: boolean;
  onToggle(): void;
  onHome(): void;
  children?: React.ReactNode;
}) {
  return (
    <div className={`bb-story bb-story-playing${playing ? " is-playing" : ""}`}>
      <button className="bb-story-home" onClick={onHome} aria-label="Back to the stories">
        <span aria-hidden>🏠</span>
      </button>
      <div className="bb-story-stage">{children ?? <div className="bb-story-big-cover"><StoryCover story={story} /></div>}</div>
      <div className="bb-story-foot">
        <span className="bb-story-barnaby" aria-hidden>
          <BarnabyAvatar size={72} />
        </span>
        <button className="bb-story-play" onClick={onToggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <PauseIcon size={72} /> : <PlayIcon size={72} />}
        </button>
      </div>
    </div>
  );
}

/** The bedtime sleep timer: fade the last seconds, then stop. */
function useSleep(sleepEndsAt: number | null, setVolume: (v: number) => void, onSleep: () => void) {
  const cb = useRef({ setVolume, onSleep });
  cb.current = { setVolume, onSleep };
  useEffect(() => {
    if (sleepEndsAt == null) return;
    const t = setInterval(() => {
      const s = sleepState({ kind: "minutes", minutes: 0, endsAt: sleepEndsAt }, Date.now(), 0);
      cb.current.setVolume(s.volume);
      if (s.stop) {
        clearInterval(t);
        cb.current.onSleep();
      }
    }, 250);
    return () => clearInterval(t);
  }, [sleepEndsAt]);
}

function AudioStory({ story, started, sleepEndsAt, onDone, onGoodnight, onSleep }: Props) {
  const [book, setBook] = useState<AudioBook | null>(null);
  useEffect(() => {
    audioApi.audio(story.id).then(setBook, () => onDone(null, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.id]);
  const start = useMemo(() => (book?.progress && !book.progress.finished ? book.progress.currentTime : 0), [book]);
  const p = useAudioPlayer(book?.tracks ?? null, start);
  const session = useStorySession(started, p.playing, (t) => (p.pause(), onGoodnight(t)));
  const pRef = useRef(p);
  pRef.current = p;

  // Start as soon as the audio is ready: the tap on Play already happened.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (book && !autoStarted.current) {
      autoStarted.current = true;
      void p.play();
    }
  }, [book, p]);

  useEffect(() => {
    if (!p.ended) return;
    void saveAudioProgress(audioApi, story.id, 0, book?.duration ?? 0, { finished: true });
    void session.finish(true).then((t) => onDone(t, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.ended]);

  useSleep(sleepEndsAt, (v) => pRef.current.setVolume(v), () => (pRef.current.pause(), onSleep()));

  const home = async () => {
    p.pause();
    if (book) void saveAudioProgress(audioApi, story.id, p.now(), book.duration);
    onDone(await session.finish(false), false);
  };

  return <Shell story={story} playing={p.playing} onToggle={p.toggle} onHome={() => void home()} />;
}

function ReadAloudStory({ story, started, sleepEndsAt, onDone, onSleep }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrl = useRef<ReadAloudController | null>(null);
  const [playing, setPlaying] = useState(false);
  const session = useStorySession(started, playing, () => {
    ctrl.current?.stop();
    setPlaying(false);
    onDone(null, false);
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let disposed = false;
    let view: FoliateView | null = null;
    (async () => {
      const detail = await api.book(story.id);
      const file = pickReadableFile(detail.files?.filter((f) => f.format !== "pdf"));
      if (!file || disposed) return onDone(null, false);
      await import("foliate-js/view.js");
      if (disposed || !hostRef.current) return;
      view = document.createElement("foliate-view") as FoliateView;
      view.className = "bb-foliate bb-story-book";
      hostRef.current.replaceChildren(view);
      await view.open(api.fileUrl(detail.id, file.id));
      view.renderer.setAttribute("flow", "paginated");
      view.renderer.setAttribute("max-column-count", "1");
      view.renderer.setAttribute("margin", "24px");
      view.renderer.setStyles?.("html { font-size: 150%; line-height: 1.5 } img { max-width: 100%; height: auto }");
      await view.init({ showTextStart: false });
      if (disposed) return;
      ctrl.current = startReadAloud(view, {
        lang: detail.language ?? "en",
        onEnd: () => {
          setPlaying(false);
          void sessionRef.current.finish(true).then((t) => onDone(t, true));
        },
      });
      setPlaying(true);
    })().catch(() => !disposed && onDone(null, false));
    return () => {
      disposed = true;
      ctrl.current?.stop();
      view?.close();
      view?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.id]);

  useSleep(sleepEndsAt, () => undefined, () => (ctrl.current?.stop(), onSleep()));

  const toggle = () => {
    if (!ctrl.current) return;
    if (playing) ctrl.current.pause();
    else ctrl.current.resume();
    setPlaying(!playing);
  };
  const home = async () => {
    ctrl.current?.stop();
    setPlaying(false);
    onDone(await session.finish(false), false);
  };

  return (
    <Shell story={story} playing={playing} onToggle={toggle} onHome={() => void home()}>
      <div className="bb-story-reader" ref={hostRef} />
    </Shell>
  );
}
