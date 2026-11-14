/**
 * Toddler storyteller mode: shared types and the "which night is it" rule.
 *
 * A parent sets a nightly allowance (a number of stories, a number of minutes, or both) and the
 * server enforces it. A "night" runs from `nightStartsHour` one day to the same hour the next day
 * in the family's time zone, so a story at 1 a.m. still counts toward the evening before.
 */

export const STORYTELLER_MODES = ["audio", "read_aloud"] as const;
export type StorytellerMode = (typeof STORYTELLER_MODES)[number];

/** Grid size bounds for the storyteller screen (big covers a toddler can hit). */
export const STORYTELLER_MIN_COVERS = 4;
export const STORYTELLER_MAX_COVERS = 9;

/** A story only uses up one of tonight's stories after this much listening. */
export const STORY_COUNTS_AFTER_SECONDS = 20;

export interface StorytellerSettings {
  /** Parent switched storyteller mode on for this kid: their home opens the storyteller screen. */
  enabled: boolean;
  /** Stories per night; null = no story limit. */
  storiesPerNight: number | null;
  /** Listening minutes per night; null = no minute limit. */
  minutesPerNight: number | null;
  /** Default sleep timer the play screen starts with, in minutes; null = off. */
  sleepTimerMinutes: number | null;
  /** Read picture books aloud with the device's text-to-speech when there's no audiobook. */
  readAloud: boolean;
  /** IANA time zone the night is counted in, e.g. "America/Chicago". */
  timeZone: string;
  /** Local hour (0-23) a new night starts. Default 12: noon to noon. */
  nightStartsHour: number;
}

export const DEFAULT_STORYTELLER_SETTINGS: StorytellerSettings = {
  enabled: false,
  storiesPerNight: null,
  minutesPerNight: null,
  sleepTimerMinutes: 20,
  readAloud: true,
  timeZone: "UTC",
  nightStartsHour: 12,
};

/** Tonight's allowance as the server sees it. */
export interface StorytellerTonight {
  /** The night's key, the local date it started on (YYYY-MM-DD). */
  night: string;
  storiesUsed: number;
  secondsUsed: number;
  /** null = no limit of that kind. */
  storiesLeft: number | null;
  secondsLeft: number | null;
  /** True when no new story may start (the goodnight screen shows). */
  goodnight: boolean;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The night `at` belongs to, as the local date (YYYY-MM-DD) that night started on.
 * Before `nightStartsHour` local time it is still the previous date's night.
 */
export function nightKey(at: Date, timeZone: string, nightStartsHour: number): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let y = get("year");
  let m = get("month");
  let d = get("day");
  const hour = get("hour");
  if (hour < nightStartsHour) {
    // Step back one calendar day (UTC date math on the local date only, no time zone involved).
    const prev = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Turn usage into what's left, given the parent's limits. */
export function tonightFrom(
  night: string,
  usage: { storiesUsed: number; secondsUsed: number },
  s: Pick<StorytellerSettings, "storiesPerNight" | "minutesPerNight">,
): StorytellerTonight {
  const storiesLeft = s.storiesPerNight == null ? null : Math.max(0, s.storiesPerNight - usage.storiesUsed);
  const secondsLeft = s.minutesPerNight == null ? null : Math.max(0, s.minutesPerNight * 60 - usage.secondsUsed);
  return {
    night,
    storiesUsed: usage.storiesUsed,
    secondsUsed: Math.round(usage.secondsUsed),
    storiesLeft,
    secondsLeft: secondsLeft == null ? null : Math.round(secondsLeft),
    goodnight: storiesLeft === 0 || secondsLeft === 0,
  };
}
