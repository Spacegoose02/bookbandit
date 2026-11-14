/** The test library: one book per content rating, plus an unrated one and one left in the inbox. */
export const BOOKS = {
  kids: { title: "Dragon Picnic", author: "Pip Willow", folder: "kids", chapters: 8 },
  kidsTwo: { title: "Moon Socks", author: "Pip Willow", folder: "kids", chapters: 2 },
  teen: { title: "Orbit of Ashes", author: "Remy Vance", folder: "teen", chapters: 2 },
  adult: { title: "Midnight Ledger", author: "Cora Black", folder: "adult", chapters: 3 },
  explicit: { title: "Velvet Confessions", author: "Lena Rose", folder: "explicit", chapters: 2 },
  /** No rating folder and no online lookup: stays unrated, which counts as adult. */
  unrated: { title: "Harbor of Whispers", author: "Sam Grey", folder: "unsorted", chapters: 2 },
  /** A kids book an admin hasn't approved yet: hidden from everyone but admins. */
  inbox: { title: "Puddle Jumpers", author: "Pip Willow", folder: "kids", chapters: 2 },
} as const;

export type BookKey = keyof typeof BOOKS;

/** What a 7-year-old may see: approved kids books only. */
export const KID_VISIBLE: BookKey[] = ["kids", "kidsTwo"];
export const KID_LOCKED: BookKey[] = ["teen", "adult", "explicit", "unrated", "inbox"];
