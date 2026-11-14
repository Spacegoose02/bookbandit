/**
 * Three short questions after a chapter. With Barnaby (AI) on for the kid, the model writes them
 * from the chapter; otherwise (or if the model's answer doesn't check out) they're made offline
 * from the text: who was in the chapter, and fill in the missing word.
 */
import type { QuizQuestion } from "./schema.js";

const STOP = new Set(
  "a about after again all also am an and any are as at back be because been before being but by came can come could day did do does down each even every for from get go going got had has have he her here him his how i if in into is it its just know like little look made make man many may me more most much must my never new no not now of off oh old on once one only or other our out over put said saw say see she should so some still such than that the their them then there these they thing think this those thought through time to too took two up upon us very want was way we well went were what when where which while who why will with would yes yet you your".split(
    " ",
  ),
);
/** Capitalised words that aren't names. */
const NOT_NAMES = new Set("I Mr Mrs Ms Miss Dr The A An And But Then When What Where Why Who How Oh Yes No It He She They We You His Her Their Our My This That There Here One Two Chapter Monday Tuesday Wednesday Thursday Friday Saturday Sunday God Mum Mom Dad Mummy Mommy Daddy Granny Grandma Grandpa".split(" "));
const DECOY_NAMES = ["Pip", "Rosie", "Otto", "Luna", "Ziggy", "Hazel", "Benji", "Mabel", "Toby", "Nell", "Rufus", "Poppy"];

/** A small seeded random, so the same quiz id always shuffles the same way (and tests are stable). */
export function seeded(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?]["”’']?)\s+(?=["“‘']?[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const wordsOf = (s: string): string[] => s.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];

/** Names: capitalised words that aren't at the start of a sentence, seen at least twice. */
export function namesIn(text: string): string[] {
  const counts = new Map<string, number>();
  for (const s of sentencesOf(text)) {
    const words = wordsOf(s);
    words.forEach((w, i) => {
      if (i === 0 || !/^\p{Lu}\p{Ll}+$/u.test(w) || NOT_NAMES.has(w)) return;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    });
  }
  const lower = new Set(wordsOf(text).filter((w) => /^\p{Ll}/u.test(w)).map((w) => w.toLowerCase()));
  return [...counts.entries()]
    .filter(([w, n]) => n >= 2 && !lower.has(w.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);
}

const contentWord = (w: string) => w.length >= 4 && /^\p{Ll}+$/u.test(w) && !STOP.has(w);

export function offlineQuiz(text: string, seed: string): QuizQuestion[] | null {
  const rnd = seeded(seed);
  const sentences = sentencesOf(text);
  const out: QuizQuestion[] = [];

  const names = namesIn(text);
  if (names.length) {
    const who = names[0]!;
    const decoys = shuffle(DECOY_NAMES.filter((n) => !text.includes(n)), rnd).slice(0, 2);
    const choices = shuffle([who, ...decoys], rnd);
    out.push({ q: "Who was in this part of the story?", choices, answer: choices.indexOf(who) });
  }

  // Fill-in-the-blank from sentences spread through the chapter, later ones first.
  const pool = sentences
    .map((s, i) => ({ s, i, words: wordsOf(s) }))
    .filter((x) => x.words.length >= 5 && x.words.length <= 22 && x.words.some(contentWord));
  const allContent = [...new Set(wordsOf(text).filter(contentWord))];
  const picks: typeof pool = [];
  for (const frac of [0.85, 0.5, 0.2, 0.65, 0.35]) {
    const target = Math.floor(sentences.length * frac);
    const best = pool.filter((x) => !picks.includes(x)).sort((a, b) => Math.abs(a.i - target) - Math.abs(b.i - target))[0];
    if (best) picks.push(best);
  }
  for (const p of picks) {
    if (out.length >= 3) break;
    const candidates = p.words.filter(contentWord).sort((a, b) => b.length - a.length);
    const answer = candidates[0]!;
    const decoys = shuffle(
      allContent.filter((w) => w !== answer && !p.words.includes(w) && Math.abs(w.length - answer.length) <= 3),
      rnd,
    ).slice(0, 2);
    if (decoys.length < 2) continue;
    const blanked = p.s.replace(new RegExp(`\\b${answer}\\b`), "_____");
    if (blanked === p.s) continue;
    const choices = shuffle([answer, ...decoys], rnd);
    out.push({ q: `Which word goes in the gap? “${blanked}”`, choices, answer: choices.indexOf(answer) });
  }
  return out.length >= 3 ? out.slice(0, 3) : null;
}

export function quizPrompt(age: number | null): string {
  const who = age != null ? `a ${age}-year-old` : "a young reader";
  return [
    `You write a tiny reading quiz for ${who} who just finished a chapter of a book.`,
    "Use ONLY the chapter text you are given. Write exactly 3 questions about what happened, who was there, or how someone felt.",
    "Each question has exactly 3 short choices (a few words each) and exactly one right answer. Use simple words. Be kind and cheerful. Nothing scary.",
    'Reply with JSON only: {"questions":[{"q":"...","choices":["...","...","..."],"answer":0}]} where answer is the index of the right choice.',
  ].join("\n");
}

/** Accepts the model's reply only if it's exactly the shape we asked for. */
export function parseQuiz(text: string): QuizQuestion[] | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]) as { questions?: unknown };
    if (!Array.isArray(raw.questions)) return null;
    const qs: QuizQuestion[] = [];
    for (const q of raw.questions.slice(0, 3) as Record<string, unknown>[]) {
      const choices = Array.isArray(q.choices) ? q.choices.filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim().slice(0, 120)) : [];
      const answer = Number(q.answer);
      if (typeof q.q !== "string" || !q.q.trim() || choices.length < 2 || choices.length > 4 || !Number.isInteger(answer) || answer < 0 || answer >= choices.length) return null;
      qs.push({ q: q.q.trim().slice(0, 300), choices, answer });
    }
    return qs.length === 3 ? qs : null;
  } catch {
    return null;
  }
}

const RIGHT = ["Yes! You got it! 🎉", "Brilliant reading! ⭐", "That's right! Barnaby is doing a happy dance! 🦝", "Spot on! 🌟", "Woohoo, correct! 🎈"];
const WRONG = ["Good try! The answer was “{a}”.", "Nearly! It was “{a}”. You'll get the next one! 💪", "Ooh, close! It was “{a}”."];

export function cheer(correct: boolean, answer: string, rnd: () => number = Math.random): string {
  const list = correct ? RIGHT : WRONG;
  return list[Math.floor(rnd() * list.length)]!.replace("{a}", answer);
}

export function finalCheer(score: number, total: number): string {
  if (score === total) return `${score} out of ${total}! Barnaby gives you a gold star! 🏆`;
  if (score >= total - 1) return `${score} out of ${total}! Super reading! ⭐`;
  return `${score} out of ${total}. Every chapter makes you a stronger reader! 📚`;
}
