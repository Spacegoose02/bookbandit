/**
 * Demo-mode data for Discover, series and categories, built on the sample books in api/demo.ts
 * so kid mode filters the same way the server would.
 */
import { demoApi } from "../api/demo";
import type { BookSummary } from "../api/types";
import type { Category, DiscoverApi, DiscoverItem, DiscoverList, ManagedCategory, SeriesBook, SeriesDetail } from "./api";

const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));

async function visibleBooks(): Promise<BookSummary[]> {
  return (await demoApi.books(new URLSearchParams({ limit: "500" }))).items;
}

function notFound(): never {
  throw Object.assign(new Error("Not found"), { status: 404, notFound: true });
}

const COLORS = ["#3d5a80", "#ee6c4d", "#6a4c93", "#2b9348", "#c9184a", "#1982c4", "#8ac926", "#ff924c"];
function outsideCover(title: string, author: string, i: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const words = title.split(" ");
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= 11) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  const text = lines
    .slice(0, 4)
    .map((l, n) => `<text x="100" y="${110 + n * 32}" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="${COLORS[i % COLORS.length]}"/><circle cx="100" cy="52" r="22" fill="#fff" fill-opacity=".25"/><g font-family="Trebuchet MS,sans-serif" font-size="25" font-weight="700" fill="#fff">${text}</g><text x="100" y="270" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#fff" fill-opacity=".85">${esc(author)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const OUTSIDE: [string, string, number][] = [
  ["The Clockwork Orchard", "Imani Castell", 2026],
  ["Salt and Starlight", "Oren Vasquez", 2025],
  ["Hollow Hill", "Priya Navarro", 2026],
  ["The Cartographer's Daughter", "Wen Li", 2024],
  ["Midnight at the Lido", "Bea Thornton", 2025],
  ["A Field Guide to Small Joys", "Tomas Ek", 2026],
];

function item(b: BookSummary): DiscoverItem {
  return {
    key: `library:${b.id}`,
    title: b.title,
    authors: b.authors?.map((a) => a.name) ?? [],
    year: b.publishedYear,
    coverUrl: null,
    source: "library",
    url: `/book/${b.id}`,
    isbn13: null,
    status: b.kindleOnly ? "kindle" : "library",
    bookId: b.id,
    coverPath: b.coverPath,
    onKindle: b.kindleOnly,
  };
}

function outside(i: number): DiscoverItem {
  const [title, author, year] = OUTSIDE[i % OUTSIDE.length]!;
  return {
    key: `openlibrary:demo${i}`,
    title,
    authors: [author],
    year,
    coverUrl: outsideCover(title, author, i),
    source: "openlibrary",
    url: "https://openlibrary.org/trending/weekly",
    isbn13: null,
    status: "request",
    bookId: null,
    coverPath: null,
    onKindle: false,
    requestable: true,
  };
}

let namedCount = 10;
/** An outside book from "Title|Author|Year". */
function named(spec: string): DiscoverItem {
  const [title, author, year] = spec.split("|") as [string, string, string];
  const i = namedCount++;
  return { ...outside(0), key: `openlibrary:demo-${title}`, title, authors: [author], year: Number(year), coverUrl: outsideCover(title, author, i), requestable: true };
}

/** Real prize winners (same list as the server's awards.ts); demo covers are drawn, not real. */
const GROWN_UP_PRIZES: [string, string, string][] = [
  ["Flesh", "David Szalay", "Booker Prize 2025"],
  ["James", "Percival Everett", "Pulitzer Prize 2025"],
  ["The Safekeep", "Yael van der Wouden", "Women's Prize 2025"],
  ["Some Desperate Glory", "Emily Tesh", "Hugo Award 2024"],
  ["Orbital", "Samantha Harvey", "Booker Prize 2024"],
  ["Night Watch", "Jayne Anne Phillips", "Pulitzer Prize 2024"],
  ["Nettle & Bone", "T. Kingfisher", "Hugo Award 2023"],
  ["Demon Copperhead", "Barbara Kingsolver", "Pulitzer Prize 2023"],
];
const KIDS_PRIZES: [string, string, string][] = [
  ["Home in the Woods", "Eliza Wheeler", "Caldecott Medal 2025"],
  ["Big", "Vashti Harrison", "Caldecott Medal 2024"],
  ["Hot Dog", "Doug Salati", "Caldecott Medal 2023"],
  ["Watercress", "Andrea Wang", "Caldecott Medal 2022"],
  ["We Are Water Protectors", "Carole Lindstrom", "Caldecott Medal 2021"],
];
function prize([title, author, note]: [string, string, string], i: number): DiscoverItem {
  return { ...named(`${title}|${author}|${note.slice(-4)}`), coverUrl: outsideCover(title, author, i), note };
}

const KID_MOODS: [string, string, string, string[]][] = [
  ["mood-funny", "Funny", "Books to make you laugh", ["b17", "b3", "b2"]],
  ["mood-cozy", "Cozy", "Warm, gentle, low-stakes", ["b15", "b16", "b1"]],
  ["mood-curious", "Curious", "Learn something amazing", ["b1", "b2"]],
];
const GROWN_MOODS: [string, string, string, string[]][] = [
  ["mood-cozy", "Cozy", "Warm, gentle, low-stakes", ["b11", "b12", "b9", "b13"]],
  ["mood-thrilling", "Edge of your seat", "Thrillers, chases and close calls", ["b10", "b7", "b8"]],
  ["mood-heartwarming", "Heartwarming", "Love, friendship and happy endings", ["b9", "b13", "b11"]],
  ["mood-spooky", "Spooky", "Ghosts, monsters and shivers", ["b10", "b4"]],
  ["mood-epic", "Epic worlds", "Big worlds to get lost in", ["b7", "b8", "b10"]],
];
const KID_OUTSIDE: [string, string, string[]][] = [
  ["ol-picture-books", "Popular picture books", ["The Snail Who Raced the Moon|Bea Pickering|2025", "Otto and the Big Sneeze|Liam Fairweather|2024", "Twelve Tiny Dragons|Mina Cho|2026", "Grandpa's Upside-Down Day|Ray Osei|2025"]],
  ["ol-chapter-books", "Popular chapter books", ["Mabel Mends a Monster|Iris Quill|2025", "The Lunchbox Detectives|Theo Banks|2024", "Ziggy and the Rocket Club|Ana Folau|2026", "Owl Post Academy|Hettie Marsh|2025"]],
];

const GENRE_DEMO: [string, string, string[]][] = [
  ["genre-fantasy", "Fantasy", ["The Ember Crown|Talia Voss|2025", "Seven Silver Doors|Rhiannon Ash|2024", "Kingdom of Glass Birds|Mateo Ruiz|2026", "The Last Lamplighter|Odile Marsh|2023", "Thornwood|Kit Adair|2025"]],
  ["genre-mystery-crime", "Mystery & crime", ["Murder at Larkspur Lane|Penny Croft|2025", "The Quiet Witness|Ravi Sethi|2024", "Dead Reckoning|Hal Brenner|2026", "A Body in the Bookshop|Nell Ashby|2025"]],
  ["genre-romance", "Romance", ["The Summer of Second Chances|Jo Bellamy|2025", "Love, Annotated|Priya Kapoor|2026", "Snowed In at Hollyfield|Clara Dunn|2024", "Meet Me at the Mill|Sam Whitlow|2025"]],
  ["genre-science-fiction", "Science fiction", ["Signal From Kepler Nine|Ade Okonjo|2026", "The Long Orbit|Freya Lund|2025", "Ghosts of the Generation Ship|Arun Pillai|2024", "Red Dust Lullaby|Vera Kostova|2025"]],
];

// Series edits made in the demo live for the page session.
const seriesEdits = new Map<string, { name?: string; description?: string | null; order?: string[] }>();
const createdSeries = new Map<string, { name: string; order: string[] }>();

async function allSeries(): Promise<SeriesDetail[]> {
  const books = await visibleBooks();
  const map = new Map<string, SeriesDetail>();
  for (const b of books)
    for (const s of b.series ?? []) {
      const entry = map.get(s.id) ?? { id: s.id, name: s.name, description: null, adminManaged: false, books: [] };
      entry.books.push({ ...b, position: s.position });
      map.set(s.id, entry);
    }
  for (const [id, c] of createdSeries)
    map.set(id, {
      id,
      name: c.name,
      description: null,
      adminManaged: true,
      books: c.order.flatMap((bid, i) => {
        const b = books.find((x) => x.id === bid);
        return b ? [{ ...b, position: i + 1 }] : [];
      }),
    });
  for (const s of map.values()) {
    s.books.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    const edit = seriesEdits.get(s.id);
    if (!edit) continue;
    if (edit.name) s.name = edit.name;
    if (edit.description !== undefined) s.description = edit.description;
    if (edit.order) {
      s.books = edit.order.flatMap((bid, i) => {
        const b = s.books.find((x) => x.id === bid);
        return b ? [{ ...b, position: i + 1 }] : [];
      });
    }
    s.adminManaged = true;
  }
  return [...map.values()].filter((s) => s.books.length);
}

const CATEGORY_RULES: [string, string, Category["kind"], RegExp][] = [
  ["cat-cook", "Cookbooks", "section", /soup|kitchen|bak/i],
  ["cat-picture", "Picture books", "section", /dino|barnaby/i],
  ["cat-adventure", "Adventure", "genre", /quest|storm|pebble|robot|road/i],
  ["cat-mystery", "Mystery", "genre", /secret|missing|lighthouse|manuscript/i],
  ["cat-literary", "Literary fiction", "genre", /garden|kyoto|lighthouse|winter/i],
];

async function categoryBooks(id: string): Promise<BookSummary[]> {
  const rule = CATEGORY_RULES.find((r) => r[0] === id);
  if (!rule) return [];
  return (await visibleBooks()).filter((b) => rule[3].test(b.title));
}

/** What the manage-categories page shows in demo mode: a tidied 900-book library. */
const MANAGED: ManagedCategory[] = (
  [
    ["Fantasy", "genre", 184],
    ["Children's Books", "genre", 161],
    ["Mystery & Crime", "genre", 97],
    ["Science Fiction", "genre", 88],
    ["Literary Fiction", "genre", 74],
    ["Thriller & Suspense", "genre", 66],
    ["History", "genre", 41],
    ["Biography & Memoir", "genre", 38],
    ["Young Adult", "genre", 35],
    ["Romance", "genre", 29],
    ["Cooking & Food", "genre", 22],
    ["Science & Nature", "genre", 19],
    ["Humor", "genre", 12],
    ["Fiction", "genre", 9],
    ["Westerns", "genre", 2],
    ["Plays & Drama", "genre", 1],
    ["Cookbooks", "section", 22],
    ["Picture books", "section", 58],
    ["Bedtime favourites", "custom", 14],
    ["Magic", "subject", 131],
    ["Wizards", "subject", 64],
    ["Dragons", "subject", 52],
    ["Detective and mystery stories", "subject", 48],
    ["Juvenile fiction", "subject", 160],
    ["England -- Fiction", "subject", 37],
    ["Schools", "subject", 31],
    ["Fiction, fantasy, epic", "subject", 28],
    ["Space opera", "subject", 17],
    ["Large type books", "subject", 4],
  ] as const
).map(([name, kind, bookCount], i) => ({
  id: `m${i}`,
  name,
  kind,
  bookCount,
  hidden: name === "Fiction",
  curated: kind === "genre",
  shown: false,
  aliases: name === "Fantasy" ? ["fantasy fiction", "epic fantasy"] : name === "Science Fiction" ? ["sci fi"] : [],
}));
let demoMinBooks = 3;
const shownNow = (c: ManagedCategory) => !c.hidden && c.kind !== "subject" && (c.kind !== "genre" || c.bookCount >= demoMinBooks);

export const demoDiscoverApi: DiscoverApi = {
  async discover() {
    const books = await visibleBooks();
    const me = await demoApi.me();
    const family = books.filter((b) => b.percent != null || ["b1", "b4", "b9", "b12"].includes(b.id)).slice(0, 8);
    const pick = (ids: string[], note?: string) =>
      ids
        .map((id) => books.find((b) => b.id === id))
        .filter((b): b is BookSummary => !!b)
        .map((b) => ({ ...item(b), ...(note ? { note } : {}) }));
    const noted = (ids: [string, string][]) => ids.flatMap(([id, note]) => pick([id], note));
    const out = (names: string[], extra: Partial<DiscoverItem> = {}) => names.map((n) => ({ ...named(n), ...extra }));
    const seen = new Set<string>();
    const lists: DiscoverList[] = [];
    // Same de-duplication as the server: a book shows in the first row that has it.
    const add = (l: Omit<DiscoverList, "items">, items: DiscoverItem[], min = 1, free = false) => {
      const fresh = free ? items : items.filter((i) => !seen.has(i.bookId ?? i.title) && seen.add(i.bookId ?? i.title));
      if (fresh.length >= min) lists.push({ ...l, items: fresh });
    };

    if (me.isKid) {
      add({ id: "parent-picks", name: "Picked by your grown-ups", source: "library", group: "foryou" }, pick(["b3", "b15"]));
      add({ id: "series-next", name: "Next in your series", source: "foryou", group: "foryou" }, pick(["b2"], "Book 2 of Dino Readers"));
      add(
        { id: "because-b1", name: "Because you read The Dinosaur Who Loved Books", source: "foryou", group: "foryou", aboutBookId: "b1" },
        noted([["b16", "A similar story"], ["b17", "Also about animals"]]),
      );
      add({ id: "kids-picture-books", name: "Picture books", source: "library", group: "kids" }, pick(["b1", "b15", "b16", "b17"]), 1, true);
      add({ id: "kids-early-readers", name: "Books I can read myself", source: "library", group: "kids" }, pick(["b2", "b17", "b1"]), 1, true);
      add({ id: "kids-animals", name: "Animals!", source: "library", group: "kids" }, pick(["b17", "b15", "b1", "b2"]), 1, true);
      add({ id: "kids-bedtime", name: "Bedtime stories", source: "library", group: "kids" }, pick(["b15", "b16"]), 1, true);
      add({ id: "kids-funny", name: "Make me laugh", source: "library", group: "kids" }, pick(["b17", "b3", "b2"]), 1, true);
      add({ id: "new-arrivals", name: "New in the library", source: "library", group: "library" }, pick(["b17", "b15", "b16", "b3"]), 1, true);
      for (const [id, name, blurb, ids] of KID_MOODS) add({ id, name, blurb, source: "library", group: "moods" }, pick(ids), 1, true);
      add({ id: "openlibrary-weekly", name: "Trending this week", source: "openlibrary", group: "popular" }, pick(["b1", "b3", "b2"]));
      add({ id: "awards-kids", name: "Award-winning kids' books", source: "awards", group: "awards" }, KIDS_PRIZES.map((p, i) => ({ ...prize(p, i), requestable: true })));
      add({ id: "family", name: "Popular in your family", source: "library", group: "family" }, family.map(item));
      return wait({ lists, online: true, requests: false });
    }

    add(
      { id: "series-next", name: "Next in your series", source: "foryou", group: "foryou" },
      [
        { ...named("Tides of Pebble Bay|Ada Brightwater|2022"), note: "Book 3 of Pebble Bay" },
        { ...named("The Pebble Bay Lantern|Ada Brightwater|2024"), note: "Book 4 of Pebble Bay" },
        ...pick(["b8"], "Book 2 of Pixel Quest"),
      ],
    );
    add(
      { id: "because-b4", name: "Because you read Storm Over Pebble Bay", source: "foryou", group: "foryou", aboutBookId: "b4" },
      [
        ...noted([["b6", "Also about adventure and friendship"], ["b9", "A similar story"]]),
        ...out(["The Salt Marsh Society|Corin Hale|2023", "Wreckers' Moon|Isla Penrose|2021", "The Kite Signal|Dev Anand Rao|2024", "Gull Island Summer|Maren Holt|2022"]),
      ],
    );
    add(
      { id: "author-ada-brightwater", name: "More by Ada Brightwater", source: "foryou", group: "foryou" },
      out(["The Clockmaker's Ferry|Ada Brightwater|2017", "A Map Made of Fog|Ada Brightwater|2021", "Harbour Lights|Ada Brightwater|2015"]),
    );
    add({ id: "parent-picks", name: "Parent picks for the family", source: "library", group: "library" }, pick(["b3", "b6", "b15"]));
    add({ id: "new-arrivals", name: "New in the library", source: "library", group: "library" }, pick(["b17", "b16", "b15", "b14", "b13", "b12"]));
    add(
      { id: "unopened", name: "Waiting on the shelf", blurb: "Nobody in the house has opened these yet", source: "library", group: "library" },
      pick(["b10", "b11", "b5", "b2", "b8"]),
    );
    add({ id: "quick-reads", name: "Quick reads", blurb: "Under 200 pages", source: "library", group: "library" }, pick(["b1", "b2", "b3", "b16", "b9"]), 2, true);
    for (const [id, name, blurb, ids] of GROWN_MOODS) add({ id, name, blurb, source: "library", group: "moods" }, pick(ids), 1, true);
    add(
      { id: "openlibrary-weekly", name: "Trending this week", source: "openlibrary", group: "popular" },
      [outside(0), ...pick(["b9"]), outside(1), ...pick(["b11"]), outside(2), ...pick(["b7"]), outside(3)],
    );
    add(
      { id: "openlibrary-new", name: "New and noteworthy", source: "openlibrary", group: "popular" },
      [outside(4), ...pick(["b13"]), outside(5), ...out(["The Ninth Orchard|Sefa Mensah|2026", "Paper Comets|Lucía Ibarra|2025", "What the River Kept|Noor Haddad|2026"])],
    );
    add({ id: "kids-picture-books", name: "Picture books", source: "library", group: "kids" }, pick(["b15", "b16", "b17", "b1"]), 1, true);
    add({ id: "kids-chapter-books", name: "Chapter books", source: "library", group: "kids" }, pick(["b4", "b5", "b6"]), 1, true);
    add({ id: "kids-animals", name: "Animal stories", source: "library", group: "kids" }, pick(["b17", "b1", "b2", "b15"]), 1, true);
    for (const [id, name, titles] of KID_OUTSIDE) add({ id, name, source: "openlibrary", group: "kids" }, out(titles), 3);
    for (const [id, name, titles] of GENRE_DEMO) add({ id, name, source: "openlibrary", group: "genres" }, out(titles), 3);
    add({ id: "awards", name: "Prize winners", source: "awards", group: "awards" }, GROWN_UP_PRIZES.map((p, i) => ({ ...prize(p, i + 3), requestable: true })));
    add({ id: "awards-kids", name: "Award-winning kids' books", source: "awards", group: "awards" }, KIDS_PRIZES.map((p, i) => ({ ...prize(p, i), requestable: true })));
    add({ id: "family", name: "Popular in your family", source: "library", group: "family" }, family.map(item));
    return wait({ lists, online: true, requests: true });
  },
  async surprise(opts = {}) {
    const books = (await visibleBooks()).filter((b) => b.percent == null && !b.kindleOnly && (!opts.kids || b.rating === "kids" || b.rating === "middle_grade"));
    return wait(books[Math.floor(Math.random() * books.length)] ?? null);
  },
  async seriesList(q) {
    const all = await allSeries();
    const items = all
      .filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()))
      .map((s) => ({ ...s, bookCount: s.books.length, books: s.books.slice(0, 4) }));
    return wait({ items, total: items.length });
  },
  async series(id) {
    const s = (await allSeries()).find((x) => x.id === id);
    if (!s) notFound();
    return wait(s);
  },
  async createSeries(name, bookIds) {
    const id = `series:new-${createdSeries.size + 1}`;
    createdSeries.set(id, { name, order: bookIds });
    return wait({ id });
  },
  async updateSeries(id, patch) {
    seriesEdits.set(id, { ...seriesEdits.get(id), ...patch });
    const created = createdSeries.get(id);
    if (created && patch.name) created.name = patch.name;
  },
  async setSeriesBooks(id, books) {
    const order = books.map((b) => b.bookId);
    const created = createdSeries.get(id);
    if (created) created.order = order;
    else seriesEdits.set(id, { ...seriesEdits.get(id), order });
    const s = (await allSeries()).find((x) => x.id === id);
    return wait((s?.books ?? []) as SeriesBook[]);
  },
  async deleteSeries(id) {
    createdSeries.delete(id);
    seriesEdits.delete(id);
  },
  async categories() {
    const out: Category[] = [];
    for (const [id, name, kind] of CATEGORY_RULES) {
      const books = await categoryBooks(id);
      if (books.length) out.push({ id, name, kind, bookCount: books.length, cookbook: id === "cat-cook", books: books.slice(0, 3) });
    }
    return wait(out);
  },
  async category(id) {
    const rule = CATEGORY_RULES.find((r) => r[0] === id);
    const items = await categoryBooks(id);
    if (!rule || !items.length) notFound();
    return wait({ category: { id, name: rule[1], kind: rule[2], cookbook: id === "cat-cook" }, items, total: items.length });
  },
  async bookCategories(bookId) {
    const books = await visibleBooks();
    const b = books.find((x) => x.id === bookId);
    if (!b) notFound();
    const items = CATEGORY_RULES.filter((r) => r[3].test(b.title)).map(([id, name, kind]) => ({
      id,
      name,
      kind,
      cookbook: id === "cat-cook",
    }));
    return wait({ items, cookbook: items.some((i) => i.cookbook) });
  },
  async manageCategories(kind, q) {
    const items = MANAGED.filter((c) => (kind === "all" || c.kind === kind || (kind === "categories" && c.kind !== "subject")) && (!q || c.name.toLowerCase().includes(q.toLowerCase())))
      .map((c) => ({ ...c, shown: shownNow(c) }))
      .sort((a, b) => b.bookCount - a.bookCount);
    const counts: Record<string, number> = {};
    for (const c of MANAGED) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
    return wait({ items, counts, minBooks: demoMinBooks });
  },
  async updateCategory(id, patch) {
    const c = MANAGED.find((x) => x.id === id);
    if (!c) notFound();
    if (patch.hidden !== undefined) c.hidden = patch.hidden;
    if (patch.kind) {
      c.kind = patch.kind;
      c.curated = false;
    }
    if (patch.name) {
      const other = MANAGED.find((x) => x.id !== id && x.kind === c.kind && x.name.toLowerCase() === patch.name!.toLowerCase());
      if (other) return demoDiscoverApi.mergeCategory(id, other.id).then(() => ({ id: other.id, merged: true }));
      c.aliases.push(c.name.toLowerCase());
      c.name = patch.name;
    }
    return wait({ id, merged: false });
  },
  async mergeCategory(id, into) {
    const from = MANAGED.findIndex((x) => x.id === id);
    const target = MANAGED.find((x) => x.id === into);
    if (from < 0 || !target) notFound();
    const [gone] = MANAGED.splice(from, 1);
    target.bookCount += gone!.bookCount;
    target.aliases.push(gone!.name.toLowerCase(), ...gone!.aliases);
    return wait({ id: into, bookCount: target.bookCount });
  },
  async setCategoryMinBooks(minBooks) {
    demoMinBooks = minBooks;
  },
  async rebuildCategories() {
    return wait({ books: 902, linked: 0 });
  },
  async kindleImport(csv, opts) {
    const rows = csv.split(/\r?\n/).slice(1).filter((l) => l.trim()).length;
    return wait({ rows, created: Math.max(0, rows - 1), linked: rows ? 1 : 0, skipped: 0, errors: [], dryRun: !!opts.dryRun });
  },
  async requestBook() {
    return wait({ status: "sent" as const });
  },
};
