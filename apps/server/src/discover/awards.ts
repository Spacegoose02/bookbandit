/**
 * Hand-picked prize lists for Discover. Open Library has no reliable "award winners" feed and the
 * NYT lists need an API key, so the winners are kept here and looked up on Open Library once a
 * week for an English cover. Update the lists when new winners are announced.
 *
 * Kids' prizes carry the audience rating the prize is for, so a kid can see (and request) a
 * Caldecott picture book while unrated outside books stay hidden from them (CLAUDE.md rule 1).
 */
import type { ContentRating } from "@bookbandit/shared";
import { openLibraryFind, type ExternalBook, type Loadable, type SourceContext } from "./sources.js";

interface Winner {
  title: string;
  author: string;
  prize: string;
  year: number;
  rating?: ContentRating;
}

const w = (prize: string, rating?: ContentRating) => (year: number, title: string, author: string): Winner => ({
  title,
  author,
  prize,
  year,
  ...(rating ? { rating } : {}),
});

const booker = w("Booker Prize");
const pulitzer = w("Pulitzer Prize");
const hugo = w("Hugo Award");
const womens = w("Women's Prize");
const nba = w("National Book Award");
const newbery = w("Newbery Medal", "middle_grade");
const caldecott = w("Caldecott Medal", "kids");
const printz = w("Printz Award", "teen");

/** Newest first within each prize, interleaved so the row mixes prizes. */
export const GROWN_UP_WINNERS: Winner[] = [
  booker(2025, "Flesh", "David Szalay"),
  pulitzer(2025, "James", "Percival Everett"),
  womens(2025, "The Safekeep", "Yael van der Wouden"),
  hugo(2024, "Some Desperate Glory", "Emily Tesh"),
  booker(2024, "Orbital", "Samantha Harvey"),
  pulitzer(2024, "Night Watch", "Jayne Anne Phillips"),
  womens(2024, "Brotherless Night", "V. V. Ganeshananthan"),
  hugo(2023, "Nettle & Bone", "T. Kingfisher"),
  booker(2023, "Prophet Song", "Paul Lynch"),
  pulitzer(2023, "Demon Copperhead", "Barbara Kingsolver"),
  nba(2023, "Blackouts", "Justin Torres"),
  pulitzer(2023, "Trust", "Hernan Diaz"),
  hugo(2022, "A Desolation Called Peace", "Arkady Martine"),
  hugo(2021, "Network Effect", "Martha Wells"),
];

export const KIDS_WINNERS: Winner[] = [
  caldecott(2025, "Home in the Woods", "Eliza Wheeler"),
  newbery(2025, "The First State of Being", "Erin Entrada Kelly"),
  caldecott(2024, "Big", "Vashti Harrison"),
  newbery(2024, "The Eyes and the Impossible", "Dave Eggers"),
  printz(2023, "Victory. Stand!", "Tommie Smith"),
  caldecott(2023, "Hot Dog", "Doug Salati"),
  newbery(2023, "Freewater", "Amina Luqman-Dawson"),
  printz(2022, "Firekeeper's Daughter", "Angeline Boulley"),
  caldecott(2022, "Watercress", "Andrea Wang"),
  newbery(2022, "The Last Cuentista", "Donna Barba Higuera"),
  printz(2021, "Everything Sad Is Untrue", "Daniel Nayeri"),
  caldecott(2021, "We Are Water Protectors", "Carole Lindstrom"),
  newbery(2021, "When You Trap a Tiger", "Tae Keller"),
  newbery(2020, "New Kid", "Jerry Craft"),
];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The winner as a card, with an English Open Library cover when one is found. */
async function resolve(ctx: SourceContext, win: Winner): Promise<ExternalBook> {
  const note = `${win.prize} ${win.year}`;
  const extra = { note, ...(win.rating ? { rating: win.rating } : {}) };
  const found = await openLibraryFind(ctx, win.title, win.author).catch(() => null);
  if (found) return { ...found, title: win.title, authors: [win.author, ...found.authors.filter((a) => a !== win.author)].slice(0, 3), ...extra };
  return {
    source: "openlibrary",
    sourceId: `award-${slug(win.title)}`,
    title: win.title,
    authors: [win.author],
    year: null,
    isbn13: null,
    coverUrl: null,
    url: `https://openlibrary.org/search?${new URLSearchParams({ title: win.title, author: win.author })}`,
    ...extra,
  };
}

async function resolveAll(ctx: SourceContext, list: Winner[]): Promise<ExternalBook[]> {
  const out: ExternalBook[] = [];
  // A few at a time: this runs once a week, there's no hurry.
  for (let i = 0; i < list.length; i += 4) out.push(...(await Promise.all(list.slice(i, i + 4).map((x) => resolve(ctx, x)))));
  return out;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

export const AWARD_LISTS: (Loadable & { name: string; kids: boolean })[] = [
  { id: "awards", name: "Prize winners", kids: false, ttl: WEEK, load: (ctx) => resolveAll(ctx, GROWN_UP_WINNERS) },
  { id: "awards-kids", name: "Award-winning kids' books", kids: true, ttl: WEEK, load: (ctx) => resolveAll(ctx, KIDS_WINNERS) },
];
