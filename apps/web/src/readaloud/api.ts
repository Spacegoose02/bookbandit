/**
 * Read-aloud and learning API (apps/server/src/narration/README.md, learning/README.md).
 * The demo version answers from canned data so the screens work offline.
 */
import { isDemo, request } from "../api/client";
import type { WordTiming } from "./ssml";

export interface NarrationStatus {
  server: boolean;
  voice: string;
  speed: number;
  wordTimings: boolean;
  mediaOverlay: boolean;
}

export interface Clip {
  id: string;
  url: string;
  words: WordTiming[] | null;
  cached: boolean;
  voice: string;
}

export interface VoicePrefs {
  userId: string;
  voice: string | null;
  speed: number;
  effectiveVoice: string;
  canEdit: boolean;
}

export interface WordHelp {
  word: string;
  headword: string;
  syllables: string[];
  meaning: string | null;
  example: string | null;
  source: "dictionary" | "family" | "ai" | "none";
}

export interface QuizView {
  id: string;
  bookId: string;
  bookTitle?: string;
  chapterLabel: string | null;
  source: "ai" | "offline";
  createdAt: number;
  completedAt: number | null;
  score: number | null;
  questions: { q: string; choices: string[]; picked: number | null; answer: number | null }[];
}

export interface AnswerResult {
  correct: boolean;
  answer: number;
  cheer: string;
  done: boolean;
  score: number | null;
  finalCheer: string | null;
}

export interface LearningSummary {
  kidId: string;
  days: number;
  stats: { quizzes: number; correct: number; questions: number; words: number };
  quizzes: QuizView[];
  words: { word: string; times: number; lastAt: number; bookTitle: string | null; found: boolean }[];
}

export interface NarrationSettings {
  enabled: boolean;
  baseUrl?: string;
  model: string;
  defaultVoice: string;
  kidVoice: string | null;
  voices: string[];
  wordTimings: boolean;
  cacheMb: number;
  timeoutMs: number;
  hasApiKey: boolean;
}

export interface NarrationAdmin {
  settings: NarrationSettings;
  cache: { clips: number; bytes: number };
  cacheDir: string;
}

export type NarrationSettingsInput = Omit<NarrationSettings, "hasApiKey"> & { apiKey?: string };

export interface TestResult {
  ok: boolean;
  ms: number;
  error?: string;
  wordTimings?: boolean;
  voices?: string[];
}

export interface ReadAloudApi {
  status(bookId: string): Promise<NarrationStatus>;
  speech(bookId: string, text: string): Promise<Clip>;
  voices(): Promise<{ voices: string[]; defaultVoice: string; kidVoice: string | null }>;
  prefs(userId: string): Promise<VoicePrefs>;
  savePrefs(userId: string, p: { voice: string | null; speed: number }): Promise<VoicePrefs>;
  word(word: string, bookId?: string, context?: string): Promise<WordHelp>;
  quiz(bookId: string, section: string, chapterLabel: string | null): Promise<QuizView>;
  answer(quizId: string, question: number, choice: number): Promise<AnswerResult>;
  kidSummary(kidId: string): Promise<LearningSummary>;
  adminSettings(): Promise<NarrationAdmin>;
  saveSettings(s: NarrationSettingsInput): Promise<NarrationAdmin>;
  test(voice?: string): Promise<TestResult>;
  clearCache(): Promise<void>;
}

const json = (b: unknown) => JSON.stringify(b);
const enc = encodeURIComponent;

const httpApi: ReadAloudApi = {
  status: (bookId) => request(`/api/narration/status?bookId=${enc(bookId)}`),
  speech: (bookId, text) => request("/api/narration/speech", { method: "POST", body: json({ bookId, text }) }),
  voices: () => request("/api/narration/voices"),
  prefs: (userId) => request(`/api/narration/people/${enc(userId)}`),
  savePrefs: (userId, p) => request(`/api/narration/people/${enc(userId)}`, { method: "PUT", body: json(p) }),
  word: (word, bookId, context) => {
    const q = new URLSearchParams();
    if (bookId) q.set("bookId", bookId);
    if (context) q.set("context", context.slice(0, 400));
    return request(`/api/learning/words/${enc(word)}?${q}`);
  },
  quiz: (bookId, section, chapterLabel) => request("/api/learning/quizzes", { method: "POST", body: json({ bookId, section, chapterLabel }) }),
  answer: (quizId, question, choice) => request(`/api/learning/quizzes/${enc(quizId)}/answer`, { method: "POST", body: json({ question, choice }) }),
  kidSummary: (kidId) => request(`/api/learning/kids/${enc(kidId)}`),
  adminSettings: () => request("/api/admin/narration/settings"),
  saveSettings: (s) => request("/api/admin/narration/settings", { method: "PUT", body: json(s) }),
  test: (voice) => request("/api/admin/narration/test", { method: "POST", body: json(voice ? { voice } : {}) }),
  clearCache: () => request("/api/admin/narration/cache", { method: "DELETE" }),
};

// --- demo --------------------------------------------------------------------
const DEMO_WORDS: Record<string, string> = {
  attic: "A room right at the top of a house, just under the roof.",
  atlas: "A book of maps.",
  tiptoe: "To walk very quietly on the ends of your toes.",
  spiral: "A shape that winds round and round, like a snail's shell or twisty stairs.",
  lighthouse: "A tall tower by the sea with a bright light that shows ships where the rocks are.",
  keeper: "Someone whose job is to look after something.",
  fog: "Thick cloud close to the ground that makes it hard to see.",
  gasp: "To breathe in suddenly because you're surprised or scared.",
  moth: "An insect like a butterfly that mostly flies at night.",
  encyclopedia: "A big book (or set of books) full of facts about lots of things.",
  plank: "A long, flat piece of wood.",
  whisper: "To speak very quietly.",
  careful: "Taking care so you don't get hurt or make a mistake.",
  spine: "The edge of a book where all the pages are held together.",
  torn: "Pulled apart or ripped.",
};

const DEMO_QUIZ: QuizView = {
  id: "demo-quiz",
  bookId: "b1",
  bookTitle: "Barnaby and the Missing Page",
  chapterLabel: "The Missing Page",
  source: "ai",
  createdAt: Date.now(),
  completedAt: null,
  score: null,
  questions: [
    { q: "Where did Barnaby live?", choices: ["In the library attic", "Under a bridge", "In a lighthouse"], picked: null, answer: null },
    { q: "What was the story Barnaby chose about?", choices: ["A dinosaur", "A lighthouse", "A birthday party"], picked: null, answer: null },
    { q: "What was wrong with the book?", choices: ["A page was missing", "It was wet", "It had no pictures"], picked: null, answer: null },
  ],
};
const DEMO_ANSWERS = [0, 1, 0];
const demoPicks: number[] = [];

const DEMO_SETTINGS: NarrationAdmin = {
  settings: {
    enabled: true,
    baseUrl: "http://kokoro:8880/v1",
    model: "kokoro",
    defaultVoice: "af_heart",
    kidVoice: "af_bella",
    voices: [],
    wordTimings: true,
    cacheMb: 500,
    timeoutMs: 60_000,
    hasApiKey: false,
  },
  cache: { clips: 1284, bytes: 186_400_000 },
  cacheDir: "/config/cache/narration",
};

const day = 86_400_000;
const demoApi: ReadAloudApi = {
  status: async () => ({ server: false, voice: "af_bella", speed: 1, wordTimings: false, mediaOverlay: false }),
  speech: async () => {
    throw new Error("No speech server in the demo");
  },
  voices: async () => ({ voices: ["af_heart", "af_bella", "af_nicole", "bf_emma", "bm_george", "am_michael"], defaultVoice: "af_heart", kidVoice: "af_bella" }),
  prefs: async (userId) => ({ userId, voice: null, speed: 1, effectiveVoice: "af_bella", canEdit: true }),
  savePrefs: async (userId, p) => ({ userId, ...p, effectiveVoice: p.voice ?? "af_bella", canEdit: true }),
  word: async (raw) => {
    const word = raw.toLowerCase().replace(/[^a-z'-]/g, "");
    const base = [word, word.replace(/es$/, ""), word.replace(/s$/, ""), word.replace(/ed$/, ""), word.replace(/d$/, "")].find((w) => DEMO_WORDS[w]) ?? word;
    const meaning = DEMO_WORDS[base] ?? null;
    const syl = word.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]*$|[^aeiouy](?=[^aeiouy]))?/g) ?? [word];
    return { word, headword: base, syllables: syl.join("") === word ? syl : [word], meaning, example: null, source: meaning ? "dictionary" : "none" };
  },
  quiz: async () => ({ ...DEMO_QUIZ, questions: DEMO_QUIZ.questions.map((q, i) => ({ ...q, picked: demoPicks[i] ?? null, answer: demoPicks[i] != null ? DEMO_ANSWERS[i]! : null })) }),
  answer: async (_id, question, choice) => {
    demoPicks[question] ??= choice;
    const done = DEMO_ANSWERS.every((_, i) => demoPicks[i] != null);
    const score = DEMO_ANSWERS.filter((a, i) => demoPicks[i] === a).length;
    const correct = demoPicks[question] === DEMO_ANSWERS[question];
    return {
      correct,
      answer: DEMO_ANSWERS[question]!,
      cheer: correct ? "Yes! You got it! 🎉" : `Good try! The answer was “${DEMO_QUIZ.questions[question]!.choices[DEMO_ANSWERS[question]!]}”.`,
      done,
      score: done ? score : null,
      finalCheer: done ? `${score} out of 3! ${score === 3 ? "Barnaby gives you a gold star! 🏆" : "Super reading! ⭐"}` : null,
    };
  },
  kidSummary: async (kidId) => ({
    kidId,
    days: 30,
    stats: { quizzes: 4, correct: 10, questions: 12, words: 7 },
    quizzes: [
      { ...DEMO_QUIZ, id: "q1", bookTitle: "Barnaby and the Missing Page", chapterLabel: "The Missing Page", completedAt: Date.now() - 2 * 3600_000, score: 3, questions: DEMO_QUIZ.questions.map((q, i) => ({ ...q, picked: DEMO_ANSWERS[i]!, answer: DEMO_ANSWERS[i]! })) },
      {
        ...DEMO_QUIZ,
        id: "q2",
        bookTitle: "The Wind in the Willows",
        chapterLabel: "The River Bank",
        source: "offline",
        createdAt: Date.now() - day,
        completedAt: Date.now() - day,
        score: 2,
        questions: [
          { q: "What was Mole busy doing at the start?", choices: ["Spring-cleaning his home", "Baking a cake", "Building a boat"], picked: 0, answer: 0 },
          { q: "Who did Mole meet by the river?", choices: ["Toad", "The Water Rat", "Badger"], picked: 0, answer: 1 },
          { q: "How did Mole feel about the river?", choices: ["Bored", "Scared", "Amazed"], picked: 2, answer: 2 },
        ],
      },
      { ...DEMO_QUIZ, id: "q3", bookTitle: "The Wind in the Willows", chapterLabel: "The Open Road", createdAt: Date.now() - 3 * day, completedAt: Date.now() - 3 * day, score: 3 },
      { ...DEMO_QUIZ, id: "q4", bookTitle: "Peter Pan", chapterLabel: "Peter Breaks Through", createdAt: Date.now() - 5 * day, completedAt: Date.now() - 5 * day, score: 2 },
    ],
    words: [
      { word: "encyclopedia", times: 2, lastAt: Date.now() - 2 * 3600_000, bookTitle: "Barnaby and the Missing Page", found: true },
      { word: "lighthouse", times: 1, lastAt: Date.now() - 3 * 3600_000, bookTitle: "Barnaby and the Missing Page", found: true },
      { word: "meadow", times: 1, lastAt: Date.now() - day, bookTitle: "The Wind in the Willows", found: true },
      { word: "scrambled", times: 1, lastAt: Date.now() - day, bookTitle: "The Wind in the Willows", found: true },
      { word: "thistledown", times: 1, lastAt: Date.now() - 2 * day, bookTitle: "The Wind in the Willows", found: true },
      { word: "nursery", times: 1, lastAt: Date.now() - 5 * day, bookTitle: "Peter Pan", found: true },
      { word: "kensington", times: 1, lastAt: Date.now() - 5 * day, bookTitle: "Peter Pan", found: false },
    ],
  }),
  adminSettings: async () => structuredClone(DEMO_SETTINGS),
  saveSettings: async (s) => ({ ...DEMO_SETTINGS, settings: { ...DEMO_SETTINGS.settings, ...s, hasApiKey: false } }),
  test: async () => ({ ok: true, ms: 420, wordTimings: true, voices: ["af_heart", "af_bella", "bm_george"] }),
  clearCache: async () => undefined,
};

export const readAloudApi: ReadAloudApi = isDemo ? demoApi : httpApi;
