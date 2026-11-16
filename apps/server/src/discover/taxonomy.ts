/**
 * The curated category list and the rules that map raw metadata subjects onto it.
 *
 * Metadata sources send a lot of subjects per book (Open Library up to 40: "Magic -- Fiction",
 * "England -- Social life and customs", "Fiction, fantasy, epic"), and before this every distinct
 * string became its own category. Now raw subjects are kept as hidden `subject` tags (search and
 * Barnaby still use them) and each book gets a few categories from the list below.
 *
 * Pure functions only, so the rules are easy to test.
 */

export interface CategoryRule {
  name: string;
  /** Matches any subject, in fiction or nonfiction books. */
  any?: RegExp;
  /** Matches only in books that look like fiction. */
  fiction?: RegExp;
  /** Matches only in books that don't look like fiction, and never a subject that says "fiction". */
  nonfiction?: RegExp;
  /** A fiction genre: a match makes a book with no other signal count as fiction. */
  fictionGenre?: boolean;
  /** Who the book is for, not what it is about: gets its own slot next to the genres. */
  audience?: boolean;
  /** Fiction or nonfiction, when the genre settles it (Romance, History); unset for Humor, Poetry, Classics. */
  kind?: "fiction" | "nonfiction";
}

/** Order matters only for ties: earlier rules win. */
export const CATEGORY_RULES: CategoryRule[] = [
  // Audience
  { name: "Children's Books", audience: true, any: /juvenile|children|picture books?|early readers?|board books?|bedtime|nursery|easy readers?|chapter books?|ages? [2-9]\b/ },
  { name: "Young Adult", audience: true, any: /young adult|\bteens?\b|teenage|\bya\b|adolescen/ },

  // Fiction
  { name: "Fantasy", fictionGenre: true, any: /fantasy|sword and sorcery/, fiction: /magic|wizard|witch|dragons?|fairies|fairy tales?|elves|mythical|imaginary|sorcer|unicorn/ },
  { name: "Science Fiction", fictionGenre: true, any: /science fiction|sci ?fi\b|space opera|cyberpunk|dystopi|steampunk/, fiction: /robots?|aliens?|extraterrestrial|time travel|apocalyp|outer space|space (ships?|travel|flight|warfare)|interplanetary|galactic|future|androids?|cloning/ },
  { name: "Mystery & Crime", fictionGenre: true, any: /myster|detective|whodunit|sleuth|private investigator|cozy/, fiction: /murder|crime|criminal|police|noir|heist/ },
  { name: "Thriller & Suspense", fictionGenre: true, any: /thriller|suspense|espionage|\bspy\b|\bspies\b/, fiction: /conspirac|terroris|assassin|kidnap|psychological/ },
  { name: "Romance", fictionGenre: true, any: /romance|romantic|love stor/, fiction: /\blove\b|courtship|dating|weddings?/ },
  { name: "Horror", fictionGenre: true, any: /horror|haunted|vampires?|zombies?|werewolf|werewolves/, fiction: /ghosts?|supernatural|monsters?|demons?/ },
  { name: "Historical Fiction", fictionGenre: true, any: /historical fiction|historical novel/, fiction: /histor|world war|\bwar\b|medieval|middle ages|victorian|regency|civil war|ancient|tudor|renaissance/ },
  { name: "Adventure", fictionGenre: true, any: /adventure|survival|pirates?|treasure|quests?\b|explorers?/ },
  { name: "Westerns", fictionGenre: true, any: /^westerns?$|western stories|western fiction/, fiction: /\bwestern\b|cowboys?|frontier and pioneer/ },
  { name: "Humor", any: /humou?r|comedy|comic fiction|funny|satire|satirical|parod|jokes/ },
  { name: "Classics", any: /\bclassics?\b|classic literature/ },
  { name: "Literary Fiction", kind: "fiction", any: /literary fiction|psychological fiction|domestic fiction|bildungsroman/, fiction: /literary|coming of age|family saga|family life|literature|friendship|families/ },
  { name: "Short Stories", kind: "fiction", any: /short stor|antholog/ },
  { name: "Poetry", any: /poetry|poems|\bpoets?\b|\bverse\b|nursery rhymes/ },
  { name: "Plays & Drama", any: /\bdrama\b|\bplays\b|theater|theatre|shakespeare/ },
  { name: "Comics & Graphic Novels", fictionGenre: true, any: /comics?\b|graphic novels?|manga|superheroes?|cartoons?/ },

  // Nonfiction
  { name: "Biography & Memoir", any: /biograph|memoir|autobiograph|personal narratives?/ },
  { name: "True Crime", any: /true crime/, nonfiction: /\bcrimes?\b|criminals?|murder|serial killers?|criminology/ },
  { name: "History", nonfiction: /histor|\bwars?\b|civilization|ancient|medieval|archaeolog|antiquities/ },
  { name: "Science & Nature", nonfiction: /science|physics|chemistry|biolog|astronom|mathemat|\bnature\b|animals|natural history|ecology|environment|evolution|geolog|zoology|botany|\bspace\b|dinosaurs?|weather|ocean/ },
  { name: "Technology & Computers", nonfiction: /computers?|programming|software|technolog|internet|engineering|electronics|artificial intelligence|coding/ },
  { name: "Business & Money", nonfiction: /business|econom|finance|money|investing|investments|management|marketing|entrepreneur|leadership|careers?/ },
  { name: "Self-Help", any: /self.help|personal growth|self.improvement/, nonfiction: /motivation|success|happiness|productivity|habits|mindfulness/ },
  { name: "Health & Fitness", nonfiction: /health|fitness|diet|nutrition|medic|exercise|wellness|yoga|diseases?/ },
  { name: "Psychology", nonfiction: /psycholog|mental|neuroscience|\bbrain\b|behavio/ },
  { name: "Philosophy", nonfiction: /philosoph|ethics|\blogic\b|stoic/ },
  { name: "Religion & Spirituality", any: /christian fiction|religious fiction|inspirational/, nonfiction: /religio|christian|bible|\bgod\b|church|spiritual|theolog|buddhis|islam|juda|prayer|faith|meditation/ },
  { name: "Politics & Society", nonfiction: /politic|government|social science|sociolog|current events|\blaw\b|legal|social issues|\brace\b|gender|feminis|culture|civil rights|immigration/ },
  { name: "Travel", nonfiction: /travel|guidebooks?|voyages|description and travel/ },
  { name: "Cooking & Food", any: /cook|recipes?|baking|cuisine|\bfood\b|\bwine\b|beverages/ },
  { name: "Art & Photography", nonfiction: /\barts?\b|painting|photograph|drawing|design|architecture|sculpture/ },
  { name: "Music", nonfiction: /music|musicians?|\bsongs?\b|composers?/ },
  { name: "Sports & Outdoors", nonfiction: /sports?|football|baseball|basketball|soccer|golf|hiking|outdoor|fishing|hunting|martial arts|cycling|running/ },
  { name: "Home & Garden", nonfiction: /garden|home improvement|\bhouse|interior|decorat|\bpets?\b|\bdogs?\b|\bcats?\b/ },
  { name: "Crafts & Hobbies", nonfiction: /crafts?\b|hobbies|knitting|sewing|quilting|woodwork|\bgames\b|puzzles|collecting/ },
  { name: "Parenting & Family", nonfiction: /parenting|child rearing|family relationships|pregnan|childbirth|marriage|relationships/ },
  { name: "Education & Reference", nonfiction: /education|teaching|study aids|reference|dictionar|encyclopedi|language|grammar|test prep|textbooks?|literary criticism|writing|authorship/ },
];

// Every rule in the nonfiction half of the list, from Biography & Memoir on, is a nonfiction genre;
// fiction genres (fictionGenre) are fiction.
{
  const firstNonfiction = CATEGORY_RULES.findIndex((r) => r.name === "Biography & Memoir");
  CATEGORY_RULES.forEach((r, i) => {
    if (r.kind) return;
    if (r.fictionGenre) r.kind = "fiction";
    else if (i >= firstNonfiction) r.kind = "nonfiction";
  });
}

/**
 * Every book with subjects is in Fiction or Nonfiction, next to its genres. Subjects that say so
 * ("Nonfiction", "Juvenile literature", "Handbooks") or its genres (History, Romance) decide; a book
 * nothing places is guessed to be Fiction, and the guess is checked again online when it can be.
 */
export const FALLBACK_FICTION = "Fiction";
export const FALLBACK_NONFICTION = "Nonfiction";
export const FALLBACK_NAMES = [FALLBACK_FICTION, FALLBACK_NONFICTION];
/** Who a book is for ("Children's Books"): sits next to a genre or a fallback, never instead of one. */
export const AUDIENCE_NAMES: string[] = CATEGORY_RULES.filter((r) => r.audience).map((r) => r.name);

/** Every name the rules can produce, for spotting curated categories among old tags. */
export const CURATED_NAMES: string[] = [...CATEGORY_RULES.map((r) => r.name), ...FALLBACK_NAMES];

/**
 * Key for spotting near-duplicates: case, accents, punctuation, "&" vs "and", and simple plurals
 * don't matter ("Fairy tales" = "Fairy Tale", "Sci-Fi" = "sci fi", "Comics & Graphic Novels" =
 * "comics and graphic novel").
 */
export function subjectKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

function singular(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lower-case, "&" → "and", with path separators ("Fiction / Fantasy / Epic", "Magic -- Fiction") kept as spaces. */
function norm(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\s*(--|\/|>|,|;)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SAYS_NONFICTION = /non.?fiction|juvenile literature|biograph|memoir|autobiograph|personal narratives?|true stor|history and criticism|study and teaching|handbooks|manuals|guidebooks?|cookbooks?/;
const SAYS_FICTION = /(^|[^n-])fiction|\bnovels?\b|\bstories\b|fairy tales|picture books?/;

/** Whether the subjects say "fiction", "nonfiction", or nothing either way. */
export function fictionSignal(subjects: string[]): "fiction" | "nonfiction" | null {
  let fic = 0;
  let non = 0;
  for (const s of subjects.map(norm)) {
    if (SAYS_NONFICTION.test(s)) non++;
    else if (SAYS_FICTION.test(s)) fic++;
  }
  if (fic > non) return "fiction";
  if (non > 0) return "nonfiction";
  return null;
}

export interface ClassifyOptions {
  /** Genres per book, not counting the audience slot. */
  max?: number;
}

export interface Classification {
  /** Children's Books or Young Adult, when a subject says so. */
  audience: string | null;
  /** "Fiction" or "Nonfiction": every book with subjects gets one. */
  kind: string | null;
  /** True when nothing said which: the kind is a guess ("Fiction") and worth checking online. */
  kindGuessed: boolean;
  /** Up to `max` curated genres. */
  genres: string[];
}

/**
 * Fiction or nonfiction from what the subjects say ("Fiction", "Juvenile Nonfiction", "Cookbooks")
 * or, failing that, from the genres they point to (Romance is fiction, History is nonfiction).
 * Curated category names can be passed as subjects too, so a book already in History reads as
 * nonfiction; leave out its current Fiction / Nonfiction, which would only repeat itself.
 */
export function bookKind(subjects: readonly string[]): "fiction" | "nonfiction" | null {
  const c = classifyBook(subjects);
  if (!c.kind || c.kindGuessed) return null;
  return c.kind === FALLBACK_NONFICTION ? "nonfiction" : "fiction";
}

/**
 * Maps a book's raw subjects onto curated categories: up to `max` genres by how many subjects point
 * at each (earlier subjects break ties, since sources list the main genre first), one audience
 * category (Children's Books or Young Adult), and Fiction or Nonfiction. When nothing says which,
 * the book is guessed to be Fiction (`kindGuessed`). A book with no subjects gets nothing.
 */
export function classifyBook(subjects: readonly string[], opts: ClassifyOptions = {}): Classification {
  const max = opts.max ?? 3;
  const list = subjects.map((s) => s?.trim()).filter((s): s is string => !!s && s.length <= 200);
  if (!list.length) return { audience: null, kind: null, kindGuessed: false, genres: [] };
  const normed = list.map(norm);
  const signal = fictionSignal(list);
  const fictionHit = (s: string) => CATEGORY_RULES.some((r) => r.fictionGenre && r.any?.test(s));
  const isFiction = signal === "fiction" || (signal === null && normed.some(fictionHit));

  const score = new Map<string, { votes: number; first: number; rank: number }>();
  normed.forEach((s, i) => {
    const mentionsFiction = SAYS_FICTION.test(s) && !/non.?fiction/.test(s);
    CATEGORY_RULES.forEach((r, rank) => {
      const hit =
        r.any?.test(s) ||
        (isFiction && r.fiction?.test(s)) ||
        (!isFiction && !mentionsFiction && r.nonfiction?.test(s));
      if (!hit) return;
      const cur = score.get(r.name);
      if (cur) cur.votes++;
      else score.set(r.name, { votes: 1, first: i, rank });
    });
  });

  // A fiction book doesn't also land in Science & Nature because a subject said "Animals".
  const byScore = [...score.entries()].sort(
    ([, a], [, b]) => b.votes - a.votes || a.first - b.first || a.rank - b.rank,
  );
  const rules = new Map(CATEGORY_RULES.map((r) => [r.name, r]));
  const genres = byScore.filter(([n]) => !rules.get(n)!.audience).slice(0, max).map(([n]) => n);
  const audience = byScore.find(([n]) => rules.get(n)!.audience)?.[0] ?? null;

  let kind: "fiction" | "nonfiction" | null = signal;
  if (!kind) {
    let fic = 0;
    let non = 0;
    for (const g of genres) {
      const k = rules.get(g)!.kind;
      if (k === "fiction") fic++;
      else if (k === "nonfiction") non++;
    }
    kind = non > fic ? "nonfiction" : fic > 0 ? "fiction" : null;
  }
  return {
    audience,
    kind: kind === "nonfiction" ? FALLBACK_NONFICTION : FALLBACK_FICTION,
    kindGuessed: !kind,
    genres,
  };
}

/** classifyBook as a flat list of names: audience, genres, then Fiction or Nonfiction. */
export function classifySubjects(subjects: readonly string[], opts: ClassifyOptions = {}): string[] {
  const c = classifyBook(subjects, opts);
  return [...(c.audience ? [c.audience] : []), ...c.genres, ...(c.kind ? [c.kind] : [])];
}

/**
 * Raw subjects worth keeping as tags: drops provider noise ("nyt:…", "Accessible book", overly
 * long strings) and near-duplicates, keeping the first spelling. "Fiction" and "Nonfiction" are
 * kept: re-filing a book from its saved subjects needs them to tell a novel from a handbook.
 */
export function cleanSubjects(subjects: readonly string[] | undefined, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of subjects ?? []) {
    const name = (s ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 40 || /[:=]/.test(name)) continue;
    if (/^(general|accessible book|protected daisy|in library|lending library|overdrive|ebooks?|large type books)$/i.test(name)) continue;
    const key = subjectKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}
