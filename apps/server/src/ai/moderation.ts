/**
 * Moderation for Barnaby. Two layers, run on what the person sends and on what the model says:
 *
 * 1. A built-in word filter that always runs for kids (no model needed, so it works even when
 *    the moderation provider is down).
 * 2. A model check when an admin picks a moderation provider. Works with any chat model told to
 *    answer {"flagged":…}, and with Llama Guard style models that answer "safe" / "unsafe\nS1".
 *
 * Fail closed for kids: if the model check errors, the message is treated as flagged.
 */
import type { AiProvider, ChatResult } from "./providers/types.js";

export type ModerationCategory = "sexual" | "self_harm" | "violence" | "drugs" | "hate" | "profanity" | "personal_info" | "other";

export interface ModerationResult {
  flagged: boolean;
  category?: ModerationCategory;
  /** "words" (built-in filter) or "model" */
  by?: "words" | "model";
}

const WORDS: { category: ModerationCategory; pattern: RegExp }[] = [
  { category: "self_harm", pattern: /\b(kill\s+my\s*self|suicid\w*|self[-\s]?harm|cut(ting)?\s+my\s*self|want\s+to\s+die|end\s+my\s+life|hurt\s+my\s*self)\b/i },
  { category: "sexual", pattern: /\b(sex\w*|porn\w*|nude\w*|boobs?|penis|vagina|erotic\w*|horny|orgasm\w*|masturbat\w*|hentai|nsfw|xxx)\b/i },
  { category: "violence", pattern: /\b(how\s+to\s+(make|build)\s+(a\s+)?(bomb|gun|weapon|explosive)|shoot\s+up|murder\s+someone|torture|behead\w*|gore)\b/i },
  { category: "drugs", pattern: /\b(cocaine|heroin|meth(amphetamine)?|weed|marijuana|get\s+high|vap(e|ing)|lsd|ecstasy|fentanyl)\b/i },
  { category: "hate", pattern: /\b(n[i1]gg\w*|f[a4]gg?ot\w*|retard\w*|k[i1]ke|sp[i1]c|ch[i1]nk)\b/i },
  { category: "profanity", pattern: /\b(f+u+c+k\w*|sh[i1]t\w*|b[i1]tch\w*|c[u\*]nt|a[s\$]{2}hole|dickhead|bastard|wh[o0]re|slut)\b/i },
];

export function wordFilter(text: string): ModerationResult {
  for (const w of WORDS) if (w.pattern.test(text)) return { flagged: true, category: w.category, by: "words" };
  return { flagged: false };
}

const CATEGORY_WORDS: [RegExp, ModerationCategory][] = [
  [/self|suicid|harm/i, "self_harm"],
  [/sex|nud|porn|S3|S4|S12/i, "sexual"],
  [/violen|weapon|S1\b|S9/i, "violence"],
  [/drug|S2\b/i, "drugs"],
  [/hate|S10/i, "hate"],
  [/profan|swear/i, "profanity"],
  [/personal|privacy|S7/i, "personal_info"],
  [/S11/i, "self_harm"],
];

function toCategory(label: string | undefined): ModerationCategory {
  if (!label) return "other";
  for (const [re, cat] of CATEGORY_WORDS) if (re.test(label)) return cat;
  return "other";
}

/** Parses either {"flagged":true,"category":"sexual"} or Llama Guard's "unsafe\nS3". */
export function parseModeration(text: string): ModerationResult {
  const t = text.trim();
  const json = /\{[\s\S]*\}/.exec(t)?.[0];
  if (json) {
    try {
      const o = JSON.parse(json) as { flagged?: unknown; safe?: unknown; category?: unknown };
      const flagged = o.flagged === true || o.safe === false;
      return flagged ? { flagged, category: toCategory(String(o.category ?? "")), by: "model" } : { flagged: false };
    } catch {
      /* fall through */
    }
  }
  if (/^unsafe\b/i.test(t)) return { flagged: true, category: toCategory(t.split(/\s+/)[1]), by: "model" };
  if (/^safe\b/i.test(t)) return { flagged: false };
  // Couldn't tell: treat as flagged so a confused model never waves something through.
  return { flagged: true, category: "other", by: "model" };
}

export function moderationPrompt(audience: { kid: boolean; age: number | null }, direction: "input" | "output"): string {
  const who = audience.kid
    ? `a child aged ${audience.age ?? "under 13"}`
    : "an adult reader in a family book app";
  return [
    `You are a content safety checker for Barnaby, a book helper talking with ${who}.`,
    `Check the ${direction === "input" ? "message the reader sent" : "reply the assistant wants to send"}.`,
    audience.kid
      ? "Flag anything not suitable for that age: sexual content, self-harm, graphic violence, drugs or alcohol, hate, swearing, scary or adult themes described in detail, or asking for or sharing personal details (full name, address, school, phone, photos)."
      : "Flag only content that is illegal, sexual content involving minors, instructions for serious harm, or self-harm encouragement.",
    'Reply with JSON only: {"flagged": true|false, "category": "sexual|self_harm|violence|drugs|hate|profanity|personal_info|other"}',
  ].join("\n");
}

export async function moderate(
  text: string,
  opts: { kid: boolean; age: number | null; direction: "input" | "output"; provider: AiProvider | null; useWords: boolean },
  call: (provider: AiProvider, run: () => Promise<ChatResult>) => Promise<ChatResult>,
): Promise<ModerationResult> {
  if (opts.useWords) {
    const w = wordFilter(text);
    if (w.flagged) return w;
  }
  if (!opts.provider) return { flagged: false };
  const provider = opts.provider;
  try {
    const r = await call(provider, () =>
      provider.chat({
        system: moderationPrompt(opts, opts.direction),
        messages: [{ role: "user", content: text.slice(0, 6000) }],
        maxTokens: 60,
        temperature: 0,
        json: true,
      }),
    );
    return parseModeration(r.text);
  } catch {
    return opts.kid ? { flagged: true, category: "other", by: "model" } : { flagged: false };
  }
}

/** What Barnaby says to a kid instead, by category. Never repeats the blocked text. */
export function kidSafeReply(category: ModerationCategory | undefined, direction: "input" | "output"): string {
  if (category === "self_harm")
    return "I'm really glad you told me. That sounds like a big feeling, and you deserve help with it. Please talk to a grown-up you trust right now, like a parent, a teacher or another family member. You're not alone. 💛";
  if (category === "personal_info")
    return "Let's keep things like your address, school and phone number private, even from me! 🦝 What else would you like to talk about? Maybe a book?";
  if (direction === "output")
    return "Hmm, I got a bit muddled there. 🦝 Let's try a different question! Want me to find you a book?";
  return "That's a question for a grown-up you trust. 🦝 I'm best at books, stories and fun facts. Want me to help you find something to read?";
}
