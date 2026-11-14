/**
 * Pure helpers for read-aloud: turn foliate-js's SSML (one block of text with a <mark> before
 * every word) into plain text plus mark offsets, split it into sentence-sized chunks for the
 * speech server, and work out which word is being spoken at a moment in the audio.
 */

export interface Mark {
  name: string;
  /** Character offset in the block's text where this word starts. */
  offset: number;
  /** The word itself (best effort; used to line up the server's word timings). */
  word: string;
}

export interface Block {
  text: string;
  marks: Mark[];
}

export interface Chunk {
  start: number;
  end: number;
  text: string;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** Walk the SSML document in order: text nodes add to the text, <mark> records where a word starts. */
export function parseSsml(ssml: string): Block {
  let text = "";
  const marks: Mark[] = [];
  let doc: Document | null = null;
  try {
    doc = new DOMParser().parseFromString(ssml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) doc = null;
  } catch {
    doc = null;
  }
  if (!doc) {
    // Fallback: regex walk, good enough for foliate's simple output.
    const re = /<mark\s+name="([^"]*)"\s*\/?>|<[^>]+>|([^<]+)/g;
    for (let m = re.exec(ssml); m; m = re.exec(ssml)) {
      if (m[1] !== undefined) marks.push({ name: m[1], offset: text.length, word: "" });
      else if (m[2] !== undefined) text += decode(m[2]);
    }
  } else {
    const walk = (n: Node) => {
      if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue ?? "";
      else if (n.nodeType === 1) {
        const el = n as Element;
        if (el.localName === "mark") marks.push({ name: el.getAttribute("name") ?? "", offset: text.length, word: "" });
        else if (el.localName === "break") text += " ";
        for (let c = el.firstChild; c; c = c.nextSibling) walk(c);
      }
    };
    walk(doc.documentElement);
  }
  // Collapse whitespace while keeping mark offsets right.
  const map: number[] = [];
  let out = "";
  let space = true;
  for (let i = 0; i < text.length; i++) {
    map[i] = out.length;
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (!space) out += " ";
      space = true;
    } else {
      out += c;
      space = false;
    }
  }
  map[text.length] = out.length;
  const trimmedStart = out.length - out.trimStart().length;
  const final = out.trim();
  const fixed = marks.map((m) => {
    const offset = Math.max(0, Math.min(final.length, map[m.offset]! - trimmedStart));
    const word = /^[\p{L}\p{N}'’-]+/u.exec(final.slice(offset))?.[0] ?? "";
    return { ...m, offset, word };
  });
  return { text: final, marks: fixed };
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Split into sentences, then pack sentences into chunks of at most `max` characters. */
export function chunkText(text: string, max = 280): Chunk[] {
  const sentences: { start: number; end: number }[] = [];
  const re = /[^.!?…]+(?:[.!?…]+["”’')\]]*|$)\s*/g;
  for (let m = re.exec(text); m && m[0]; m = re.exec(text)) sentences.push({ start: m.index, end: m.index + m[0].length });
  if (!sentences.length && text) sentences.push({ start: 0, end: text.length });
  const chunks: Chunk[] = [];
  let cur: { start: number; end: number } | null = null;
  const push = (c: { start: number; end: number }) => {
    const raw = text.slice(c.start, c.end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) chunks.push({ start: c.start + lead, end: c.start + lead + t.length, text: t });
  };
  for (const s of sentences) {
    // A single very long sentence: split at commas or spaces.
    if (s.end - s.start > max) {
      if (cur) push(cur), (cur = null);
      let a = s.start;
      while (s.end - a > max) {
        const slice = text.slice(a, a + max);
        const cut = Math.max(slice.lastIndexOf(", "), slice.lastIndexOf("; "));
        const at = cut > max / 3 ? cut + 2 : slice.lastIndexOf(" ") > 0 ? slice.lastIndexOf(" ") + 1 : max;
        push({ start: a, end: a + at });
        a += at;
      }
      cur = { start: a, end: s.end };
      continue;
    }
    if (cur && s.end - cur.start <= max) cur.end = s.end;
    else {
      if (cur) push(cur);
      cur = { ...s };
    }
  }
  if (cur) push(cur);
  return chunks;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * When each word of the chunk starts, in seconds. With the server's word timings we line the
 * words up in order (skipping punctuation tokens); without them, or for words we couldn't match,
 * we estimate by character position across the clip's length.
 */
export function wordSchedule(chunk: Chunk, marks: Mark[], timings: WordTiming[] | null, duration: number): { name: string; at: number }[] {
  const inChunk = marks.filter((m) => m.offset >= chunk.start && m.offset < chunk.end);
  const len = Math.max(1, chunk.end - chunk.start);
  const estimate = (m: Mark) => (duration > 0 && Number.isFinite(duration) ? ((m.offset - chunk.start) / len) * duration : 0);
  if (!timings?.length) return inChunk.map((m) => ({ name: m.name, at: estimate(m) }));
  const tokens = timings.filter((t) => norm(t.word));
  const out: { name: string; at: number }[] = [];
  let ti = 0;
  for (const m of inChunk) {
    const w = norm(m.word);
    let found = -1;
    for (let k = ti; k < Math.min(tokens.length, ti + 4); k++) {
      const t = norm(tokens[k]!.word);
      if (t && w && (t === w || t.startsWith(w) || w.startsWith(t))) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      out.push({ name: m.name, at: tokens[found]!.start });
      ti = found + 1;
    } else out.push({ name: m.name, at: estimate(m) });
  }
  // Keep the schedule in order even when an estimate lands between matched words.
  for (let i = 1; i < out.length; i++) if (out[i]!.at < out[i - 1]!.at) out[i]!.at = out[i - 1]!.at;
  return out;
}

/** The mark being spoken at `t` seconds, or null before the first word. */
export function markAt(schedule: { name: string; at: number }[], t: number): string | null {
  let lo = 0;
  let hi = schedule.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (schedule[mid]!.at <= t + 0.02) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? schedule[best]!.name : null;
}

/** The word under a character offset in a text node (for tap-a-word). */
export function wordAround(text: string, offset: number): { word: string; start: number; end: number } | null {
  const isW = (c: string | undefined) => !!c && /[\p{L}\p{N}'’-]/u.test(c);
  let s = Math.min(offset, text.length);
  let e = s;
  if (!isW(text[s]) && isW(text[s - 1])) s = e = s - 1;
  if (!isW(text[s])) return null;
  while (s > 0 && isW(text[s - 1])) s--;
  while (e < text.length && isW(text[e])) e++;
  const raw = text.slice(s, e);
  const lead = raw.length - raw.replace(/^['’-]+/, "").length;
  const word = raw.replace(/^['’-]+|['’-]+$/g, "");
  if (!word || !/\p{L}/u.test(word)) return null;
  return { word, start: s + lead, end: s + lead + word.length };
}

/** The sentence around a word, for "what does it mean here?". */
export function sentenceAround(text: string, start: number, end: number, max = 300): string {
  const before = text.slice(0, start);
  const a = Math.max(before.search(/[^.!?]*$/), start - max / 2);
  const rest = text.slice(end);
  const stop = rest.search(/[.!?]/);
  const b = Math.min(end + (stop < 0 ? rest.length : stop + 1), end + max / 2);
  return text.slice(Math.max(0, a), b).replace(/\s+/g, " ").trim();
}
