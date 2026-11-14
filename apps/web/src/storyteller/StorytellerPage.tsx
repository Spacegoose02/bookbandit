import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import type { StorytellerMode, StorytellerTonight } from "@bookbandit/shared";
import { useSession } from "../app/session";
import { BarnabyAvatar, BarnabyEmpty } from "../brand/Barnaby";
import { PlayIcon } from "../audio/ListenPage";
import { GoodnightError, storytellerApi, type StartedStory, type Story, type StorytellerScreen } from "./api";
import { Goodnight } from "./Goodnight";
import { readAloudSupported } from "./readAloud";
import { StoryCover } from "./StoryCover";
import { StoryPlayer } from "./StoryPlayer";
import "./storyteller.css";

/** How a story will be told: its audiobook if it has one, otherwise read aloud. */
export function storyMode(story: Story): StorytellerMode | null {
  if (story.hasAudio) return "audio";
  if (story.canReadAloud && readAloudSupported()) return "read_aloud";
  return null;
}

/**
 * Toddler storyteller: /storyteller. A full-screen grid of big covers a parent picked, one big
 * play button, a sleep timer, and Barnaby's goodnight screen when tonight's stories are done.
 * The nightly limit is enforced by the server; this screen just follows what it says.
 */
export function StorytellerPage() {
  const { me } = useSession();
  const [screen, setScreen] = useState<StorytellerScreen | null>(null);
  const [error, setError] = useState(false);
  const [tonight, setTonight] = useState<StorytellerTonight | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ story: Story; started: StartedStory } | null>(null);
  const [starting, setStarting] = useState(false);
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null);
  const [sleptOff, setSleptOff] = useState(false);
  const [heard, setHeard] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!me?.isKid) return;
    storytellerApi.screen("me").then(
      (s) => {
        setScreen(s);
        setTonight(s.tonight);
        const first = s.stories.find((x) => storyMode(x));
        setSelected(first?.id ?? null);
      },
      () => setError(true),
    );
  }, [me?.isKid]);

  // The bedtime sleep timer runs across stories, from the first tap of Play.
  useEffect(() => {
    if (sleepEndsAt == null) return;
    const t = setTimeout(() => setSleptOff(true), Math.max(0, sleepEndsAt - Date.now()));
    return () => clearTimeout(t);
  }, [sleepEndsAt]);

  const play = useCallback(async () => {
    const story = screen?.stories.find((s) => s.id === selected);
    const mode = story && storyMode(story);
    if (!story || !mode || starting) return;
    setStarting(true);
    try {
      const started = await storytellerApi.start(story.id, mode);
      setTonight(started.tonight);
      setPlaying({ story, started });
      if (sleepEndsAt == null && screen?.settings.sleepTimerMinutes) {
        setSleepEndsAt(Date.now() + screen.settings.sleepTimerMinutes * 60_000);
      }
    } catch (e) {
      if (e instanceof GoodnightError) setTonight(e.tonight);
    } finally {
      setStarting(false);
    }
  }, [screen, selected, starting, sleepEndsAt]);

  const done = (t: StorytellerTonight | null, completed: boolean) => {
    const id = playing?.story.id;
    if (id && completed) setHeard((h) => new Set(h).add(id));
    setPlaying(null);
    if (t) setTonight(t);
  };

  if (me && !me.isKid) return <Navigate to="/storyteller/setup" replace />;
  if (error) return <BarnabyEmpty title="Uh oh! Ask a grown-up to check story time." />;
  if (!screen || !tonight) return <div className="bb-story bb-story-loading" aria-busy="true" />;

  const name = screen.kid.displayName;
  if (sleptOff || (tonight.goodnight && !playing)) return <Goodnight name={name} />;

  if (playing) {
    return (
      <StoryPlayer
        story={playing.story}
        started={playing.started}
        sleepEndsAt={sleepEndsAt}
        onDone={done}
        onGoodnight={(t) => (setTonight(t), setPlaying(null))}
        onSleep={() => setSleptOff(true)}
      />
    );
  }

  const stories = screen.stories.filter((s) => storyMode(s));
  if (!stories.length)
    return (
      <div className="bb-story">
        <BarnabyEmpty title={`No stories yet, ${name}! Ask a grown-up to pick some.`} />
      </div>
    );

  return (
    <div className="bb-story">
      <header className="bb-story-head">
        <BarnabyAvatar size={64} />
        <div className="bb-bubble bb-story-bubble">Pick a story, {name}!</div>
        <TonightBadge tonight={tonight} sleepEndsAt={sleepEndsAt} />
      </header>
      <div className="bb-story-grid" data-count={Math.min(stories.length, 9)} role="radiogroup" aria-label="Stories">
        {stories.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={selected === s.id}
            aria-label={s.title}
            className="bb-story-cover"
            onClick={() => setSelected(s.id)}
            onDoubleClick={() => void play()}
          >
            <span className="bb-story-frame">
              <StoryCover story={s} />
              {heard.has(s.id) && (
                <span className="bb-story-heard" aria-hidden>
                  ⭐
                </span>
              )}
              <span className="bb-story-kind" aria-hidden>
                {s.hasAudio ? "🎧" : "🗣️"}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="bb-story-foot">
        <button className="bb-story-play" onClick={() => void play()} disabled={!selected || starting} aria-label="Play the story">
          <PlayIcon size={72} />
        </button>
      </div>
    </div>
  );
}

/** Stars for stories left tonight and a moon with the minutes left, for kids who can't read yet. */
function TonightBadge({ tonight, sleepEndsAt }: { tonight: StorytellerTonight; sleepEndsAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  const ref = useRef(0);
  useEffect(() => {
    ref.current = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(ref.current);
  }, []);
  const sleepMin = sleepEndsAt ? Math.max(0, Math.ceil((sleepEndsAt - now) / 60_000)) : null;
  return (
    <div className="bb-story-tonight">
      {tonight.storiesLeft != null && (
        <span aria-label={`${tonight.storiesLeft} stories left tonight`}>
          {Array.from({ length: Math.min(tonight.storiesLeft, 9) }, (_, i) => (
            <span key={i} aria-hidden>
              ⭐
            </span>
          ))}
        </span>
      )}
      {sleepMin != null && (
        <span className="bb-story-moon" aria-label={`${sleepMin} minutes until sleep`}>
          🌙 {sleepMin}
        </span>
      )}
    </div>
  );
}
