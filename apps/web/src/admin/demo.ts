/**
 * Sample data for the admin and family pages in demo mode (`?demo`), so they can be developed
 * and screenshotted without a server. Kept in memory; a reload starts over.
 */
import type { ContentRating } from "@bookbandit/shared";
import type {
  AdminApi,
  AdminBook,
  ChatMessage,
  Device,
  InboxItem,
  InboxFilter,
  KidCard,
  KidDetail,
  KidStats,
  MetadataSettings,
  ScanStatus,
  UnratedBook,
  UserView,
} from "./api";

const now = Date.UTC(2026, 10, 14, 2, 0);
const H = 3_600_000;
const D = 24 * H;
const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 60));

const COLORS = ["#264653", "#e76f51", "#2a9d8f", "#8338ec", "#3a86ff", "#ff006e", "#8d6e63"];
function cover(title: string, i: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="${COLORS[i % COLORS.length]}"/><text x="100" y="140" text-anchor="middle" font-family="Georgia,serif" font-size="22" font-weight="700" fill="#fff">${esc(title.split(" ").slice(0, 2).join(" "))}</text><text x="100" y="170" text-anchor="middle" font-family="Georgia,serif" font-size="22" font-weight="700" fill="#fff">${esc(title.split(" ").slice(2, 4).join(" "))}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const file = (relPath: string, sizeBytes: number) => ({ id: relPath, relPath, format: relPath.split(".").pop()!, sizeBytes });

let inbox: InboxItem[] = [
  {
    id: "i1",
    title: "The Owl Who Counted Stars",
    subtitle: null,
    authors: ["Juniper Vale"],
    publishedYear: 2024,
    isbn13: "9781234567897",
    coverPath: cover("The Owl Who Counted Stars", 0),
    description: "A sleepy owl learns to count every star before morning.",
    rating: "kids",
    ratingSource: "folder",
    files: [file("Kids/Juniper Vale/The Owl Who Counted Stars.epub", 2_400_000)],
    addedAt: now - 2 * H,
    possibleDuplicates: [
      { id: "b9", title: "The Owl Who Counted Stars", approved: false, volume: null, isbn13: null, sameIsbn: false, addedAt: now - 26 * H, files: [{ format: "pdf", sizeBytes: 9_800_000 }] },
    ],
    barnaby: { rating: { rating: "kids", confidence: 0.92, reasons: "A gentle bedtime picture book about counting." }, fixes: [] },
  },
  {
    id: "i2",
    title: "Storm Over Pebble Bay",
    subtitle: "Pebble Bay #1",
    authors: ["Ada Brightwater"],
    publishedYear: 2019,
    isbn13: "9780000000019",
    coverPath: cover("Storm Over Pebble Bay", 1),
    description: "Two cousins, one lighthouse, and a storm that won't quit.",
    rating: "middle_grade",
    ratingSource: "metadata",
    files: [file("_incoming/storm-over-pebble-bay.pdf", 8_100_000)],
    addedAt: now - 5 * H,
    possibleDuplicates: [
      { id: "b4", title: "Storm Over Pebble Bay", approved: true, volume: 1, isbn13: "9780000000019", sameIsbn: true, addedAt: now - 40 * 24 * H, files: [{ format: "epub", sizeBytes: 1_200_000 }] },
    ],
    barnaby: {
      rating: { rating: "middle_grade", confidence: 0.81, reasons: "Adventure for 8 to 12, a storm but nothing scary." },
      fixes: [
        {
          id: "f2",
          field: "series",
          current: null,
          suggested: { name: "Pebble Bay", position: 1 },
          reason: "The subtitle holds the series.",
        },
      ],
    },
  },
  {
    id: "i3",
    title: "night_shift_v2",
    subtitle: null,
    authors: [],
    publishedYear: null,
    isbn13: null,
    coverPath: null,
    description: null,
    rating: null,
    ratingSource: null,
    files: [file("_incoming/night_shift_v2.epub", 640_000)],
    addedAt: now - 26 * H,
    possibleDuplicates: [],
    barnaby: {
      rating: { rating: "adult", confidence: 0.55, reasons: "Hard to tell from the opening pages; some violence." },
      fixes: [
        { id: "f3", field: "title", current: "night_shift_v2", suggested: "Night Shift", reason: "File-name junk in the title." },
        { id: "f4", field: "authors", current: [], suggested: ["Mara Quill"], reason: "The title page names the author." },
      ],
    },
  },
  {
    id: "i4",
    title: "Midnight in the Orchard",
    subtitle: null,
    authors: ["Thomas Reyes"],
    publishedYear: 2021,
    isbn13: null,
    coverPath: cover("Midnight in the Orchard", 3),
    description: "A slow-burning literary mystery set over one harvest.",
    rating: "adult",
    ratingSource: "keywords",
    files: [file("Adult/Thomas Reyes/Midnight in the Orchard.epub", 1_100_000)],
    addedAt: now - 30 * H,
    possibleDuplicates: [],
    barnaby: { rating: null, fixes: [] },
  },
];

const UNRATED_PICKS: (UnratedBook["barnaby"]["rating"])[] = [
  null,
  { rating: "kids", confidence: 0.74, reasons: "A children's activity annual." },
  { rating: "middle_grade", confidence: 0.66, reasons: "Nature writing a 10-year-old could read; one hunting scene." },
];

let unrated: UnratedBook[] = [
  ["Untitled Manuscript", "Unknown", 2010],
  ["Comet Kids Annual 2025", "Various", 2025],
  ["Field Notes on Foxes", "Ines Calder", 2017],
].map(([title, author, year], i) => ({
  id: `u${i + 1}`,
  title: title as string,
  subtitle: null,
  authors: [author as string],
  description: null,
  publisher: null,
  language: "en",
  publishedYear: year as number,
  isbn13: null,
  coverPath: i === 0 ? null : cover(title as string, i + 4),
  rating: null,
  ratingSource: null,
  approved: true,
  files: [file(`Misc/${title}.epub`, 900_000)],
  addedAt: now - (i + 3) * D,
  barnaby: { rating: UNRATED_PICKS[i] ?? null },
}));

const scan: ScanStatus = {
  running: false,
  startedAt: now - 3 * H,
  progress: { done: 1284, total: 1284 },
  lastReport: {
    startedAt: now - 3 * H,
    finishedAt: now - 3 * H + 94_000,
    filesSeen: 1284,
    unchanged: 1270,
    added: 4,
    attached: 2,
    updated: 1,
    moved: 3,
    removed: 0,
    duplicates: [{ relPath: "_incoming/dune (1).epub", sameAs: "Adult/Frank Herbert/Dune.epub" }],
    missingBookIds: [],
    errors: [{ relPath: "_incoming/broken.cbz", error: "metadata: not a zip file" }],
  },
  lastError: null,
};

const user = (u: Partial<UserView> & Pick<UserView, "id" | "displayName" | "role">): UserView => ({
  birthYear: null,
  explicitOptIn: false,
  avatar: null,
  theme: "dark",
  kidSignInMethod: null,
  signIn: "google",
  disabled: false,
  identities: [],
  parentIds: [],
  kidIds: [],
  createdAt: now - 40 * D,
  ...u,
});

let people: UserView[] = [
  user({ id: "u-adult", displayName: "Sam", role: "admin", avatar: "🦝", identities: [{ id: "x1", provider: "tinyauth", subject: "sam@example.com" }], kidIds: ["u-kid", "u-kid2"] }),
  user({ id: "u-alex", displayName: "Alex", role: "parent", avatar: "🌻", identities: [{ id: "x2", provider: "tinyauth", subject: "alex@example.com" }], kidIds: ["u-kid", "u-kid2"] }),
  user({ id: "u-gran", displayName: "Grandma Rose", role: "adult", avatar: "🧶", signIn: "password", identities: [{ id: "x3", provider: "local", subject: "rose" }] }),
  user({ id: "u-kid", displayName: "Mia", role: "kid", avatar: "🦖", theme: "dinosaur", birthYear: 2018, kidSignInMethod: "picture", signIn: "picture", parentIds: ["u-adult", "u-alex"] }),
  user({ id: "u-kid2", displayName: "Theo", role: "kid", avatar: "🚀", theme: "storm", birthYear: 2014, kidSignInMethod: "pin", signIn: "pin", parentIds: ["u-adult", "u-alex"] }),
];

let devices: Device[] = [
  { id: "d1", name: "Living room tablet", userId: null, lastSeenAt: now - 20 * 60_000, revokedAt: null, createdAt: now - 30 * D },
  { id: "d2", name: "Mia's Fire tablet", userId: "u-kid", lastSeenAt: now - 14 * H, revokedAt: null, createdAt: now - 12 * D },
  { id: "d3", name: "Kobo Clara", userId: "u-adult", lastSeenAt: now - 3 * D, revokedAt: null, createdAt: now - 20 * D },
  { id: "d4", name: "Old phone", userId: null, lastSeenAt: now - 60 * D, revokedAt: now - 45 * D, createdAt: now - 90 * D },
];

let abs: Awaited<ReturnType<AdminApi["absSettings"]>> = {
  configured: true,
  enabled: true,
  url: "http://192.168.1.20:13378",
  libraryIds: [],
  hasToken: true,
};
let smtp: Awaited<ReturnType<AdminApi["smtpSettings"]>> = { configured: false };
let metadata: MetadataSettings = { online: true, hasHardcoverToken: false, hasGoogleApiKey: true, fromEnv: { hardcoverToken: false, googleApiKey: true }, saved: false };

function card(u: UserView): KidCard {
  const age = u.birthYear ? 2026 - u.birthYear : null;
  const maxRating: ContentRating = age == null ? "kids" : age >= 13 ? "teen" : age >= 9 ? "middle_grade" : "kids";
  return { id: u.id, displayName: u.displayName, avatar: u.avatar, birthYear: u.birthYear, age, maxRating, kidSignInMethod: u.kidSignInMethod, disabled: u.disabled };
}

const kidDetails: Record<string, Omit<KidDetail, "kid">> = {
  "u-kid": {
    stats: { readingNow: 2, finished: 9, finishedLast30Days: 3, booksOpenedLast7Days: 4, lastReadAt: now - 14 * H, lastBook: { id: "b1", title: "The Dinosaur Who Loved Books" }, pendingRequests: 1, aiQuestionsLast7Days: 6, aiFlaggedLast7Days: 0 },
    reading: [
      { bookId: "b1", title: "The Dinosaur Who Loved Books", authors: ["Pip Harlow"], coverPath: cover("The Dinosaur Who Loved Books", 1), rating: "kids", percent: 0.6, finished: false, deviceName: "Mia's Fire tablet", updatedAt: now - 14 * H },
      { bookId: "b3", title: "Barnaby and the Missing Page", authors: ["Juniper Vale"], coverPath: cover("Barnaby and the Missing Page", 2), rating: "kids", percent: 0.25, finished: false, deviceName: "Living room tablet", updatedAt: now - 2 * D },
      { bookId: "b2", title: "Dino Goes to School", authors: ["Pip Harlow"], coverPath: cover("Dino Goes to School", 4), rating: "kids", percent: 1, finished: true, deviceName: "Mia's Fire tablet", updatedAt: now - 4 * D },
    ],
    requests: [
      { id: "r1", title: "Dog Man: Mothering Heights", author: "Dav Pilkey", rating: "kids", status: "pending", note: null, createdAt: now - 20 * H },
      { id: "r2", title: "The Wild Robot", author: "Peter Brown", rating: "middle_grade", status: "approved", note: "Bedtime book", createdAt: now - 9 * D },
    ],
    chats: [
      { conversationId: "c1", startedAt: now - 15 * H, lastAt: now - 14.8 * H, messages: 6, flagged: 0, bookId: "b1", bookTitle: "The Dinosaur Who Loved Books", preview: "Why does the dinosaur like books so much?" },
      { conversationId: "c2", startedAt: now - 3 * D, lastAt: now - 3 * D + 300_000, messages: 4, flagged: 0, bookId: null, bookTitle: null, preview: "What do owls eat?" },
    ],
  },
  "u-kid2": {
    stats: { readingNow: 1, finished: 23, finishedLast30Days: 2, booksOpenedLast7Days: 2, lastReadAt: now - 2 * H, lastBook: { id: "b6", title: "The Robot Next Door" }, pendingRequests: 0, aiQuestionsLast7Days: 11, aiFlaggedLast7Days: 1 },
    reading: [
      { bookId: "b6", title: "The Robot Next Door", authors: ["Kenji Morrow"], coverPath: cover("The Robot Next Door", 5), rating: "middle_grade", percent: 0.82, finished: false, deviceName: "Living room tablet", updatedAt: now - 2 * H },
      { bookId: "b5", title: "Secrets of Pebble Bay", authors: ["Ada Brightwater"], coverPath: cover("Secrets of Pebble Bay", 6), rating: "middle_grade", percent: 1, finished: true, deviceName: "Living room tablet", updatedAt: now - 6 * D },
    ],
    requests: [{ id: "r3", title: "Pixel Quest: Level Three", author: "Rae Okafor", rating: "teen", status: "declined", note: "Above Theo's age setting", createdAt: now - 2 * D }],
    chats: [
      { conversationId: "c3", startedAt: now - 3 * H, lastAt: now - 2.6 * H, messages: 8, flagged: 1, bookId: "b6", bookTitle: "The Robot Next Door", preview: "Is the robot going to get destroyed at the end??" },
    ],
  },
};

const chats: Record<string, ChatMessage[]> = {
  c1: [
    { id: "m1", role: "user", content: "Why does the dinosaur like books so much?", moderation: null, createdAt: now - 15 * H },
    { id: "m2", role: "assistant", content: "Great question! Rexy loves books because every page takes him somewhere new, even places dinosaurs never got to visit. Which place in the story would you visit?", moderation: null, createdAt: now - 15 * H + 5000 },
    { id: "m3", role: "user", content: "the library on the moon", moderation: null, createdAt: now - 14.9 * H },
    { id: "m4", role: "assistant", content: "Me too! I'd borrow a book about craters. 🌙", moderation: null, createdAt: now - 14.9 * H + 4000 },
  ],
  c2: [
    { id: "m5", role: "user", content: "What do owls eat?", moderation: null, createdAt: now - 3 * D },
    { id: "m6", role: "assistant", content: "Owls mostly eat mice, insects and sometimes fish. They swallow small things whole!", moderation: null, createdAt: now - 3 * D + 4000 },
  ],
  c3: [
    { id: "m7", role: "user", content: "Is the robot going to get destroyed at the end??", moderation: null, createdAt: now - 3 * H },
    { id: "m8", role: "assistant", content: "No spoilers from me! You're 82% through, so the answer is just a few chapters away.", moderation: null, createdAt: now - 3 * H + 4000 },
    { id: "m9", role: "user", content: "tell me or ill [removed]", moderation: "rewritten: rude language", createdAt: now - 2.7 * H },
    { id: "m10", role: "assistant", content: "Let's keep it kind! Want to guess what happens instead?", moderation: null, createdAt: now - 2.7 * H + 4000 },
  ],
};

function notFound(): never {
  throw Object.assign(new Error("Not found"), { status: 404 });
}

function overviewNow() {
  return {
    inbox: inbox.length,
    unrated: unrated.length,
    books: 1284,
    people: { grownUps: people.filter((p) => p.role !== "kid").length, kids: people.filter((p) => p.role === "kid").length },
    devices: devices.filter((d) => !d.revokedAt).length,
    pendingRequests: 1,
  };
}

export const demoAdminApi: AdminApi = {
  overview: () => delay(overviewNow()),
  scanStatus: () => delay(scan),
  async startScan() {
    scan.running = true;
    scan.startedAt = Date.now();
    scan.progress = { done: 0, total: 1284 };
    const tick = setInterval(() => {
      scan.progress = { done: Math.min(1284, (scan.progress?.done ?? 0) + 321), total: 1284 };
      if (scan.progress.done >= 1284) {
        scan.running = false;
        clearInterval(tick);
      }
    }, 700);
    return delay(scan);
  },

  inbox: (_offset = 0, filter: InboxFilter = "all") => {
    const pick: Record<InboxFilter, (b: InboxItem) => boolean> = {
      all: () => true,
      suggested: (b) => !!b.barnaby.rating || b.barnaby.fixes.length > 0,
      unseen: (b) => !b.barnaby.rating && !b.barnaby.fixes.length,
    };
    const counts = { all: inbox.length, suggested: inbox.filter(pick.suggested).length, unseen: inbox.filter(pick.unseen).length };
    const items = inbox.filter(pick[filter]);
    return delay({ items, total: items.length, counts, limit: 50, offset: 0 });
  },
  async approve(ids, opts = {}) {
    for (const b of inbox.filter((x) => ids.includes(x.id))) {
      const rating = opts.rating ?? (opts.barnabyRating ? b.barnaby.rating?.rating : undefined) ?? b.rating;
      if (!rating) unrated.push({ ...b, publisher: null, language: null, approved: true, rating: null, barnaby: { rating: b.barnaby.rating } });
    }
    inbox = inbox.filter((b) => !ids.includes(b.id));
    return delay({ approved: ids.length });
  },
  async acceptBarnabyRatings(bookIds) {
    const n = unrated.filter((b) => bookIds.includes(b.id) && b.barnaby.rating).length;
    unrated = unrated.filter((b) => !(bookIds.includes(b.id) && b.barnaby.rating));
    inbox = inbox.map((b) =>
      bookIds.includes(b.id) && b.barnaby.rating ? { ...b, rating: b.barnaby.rating.rating, ratingSource: "admin", barnaby: { ...b.barnaby, rating: null } } : b,
    );
    return delay({ accepted: n });
  },
  async dismissBarnabyRating(bookId) {
    unrated = unrated.map((b) => (b.id === bookId ? { ...b, barnaby: { rating: null } } : b));
    inbox = inbox.map((b) => (b.id === bookId ? { ...b, barnaby: { ...b.barnaby, rating: null } } : b));
    await delay(null);
  },
  async acceptFix(id) {
    inbox = inbox.map((b) => {
      const fix = b.barnaby.fixes.find((f) => f.id === id);
      if (!fix) return b;
      const v = fix.suggested;
      const patch = fix.field === "authors" ? { authors: v as string[] } : fix.field === "series" ? {} : { [fix.field]: v };
      return { ...b, ...patch, barnaby: { ...b.barnaby, fixes: b.barnaby.fixes.filter((f) => f.id !== id) } };
    });
    await delay(null);
  },
  async dismissFix(id) {
    inbox = inbox.map((b) => ({ ...b, barnaby: { ...b.barnaby, fixes: b.barnaby.fixes.filter((f) => f.id !== id) } }));
    await delay(null);
  },
  askBarnaby: () => delay({ rating: true, metadata: true }),
  async reject(id) {
    inbox = inbox.filter((b) => b.id !== id);
  },
  unrated: () => delay({ items: unrated, total: unrated.length, limit: 50, offset: 0 }),
  async setRating(id, rating) {
    if (rating) unrated = unrated.filter((b) => b.id !== id);
    inbox = inbox.map((b) => (b.id === id ? { ...b, rating, ratingSource: rating ? "admin" : null, barnaby: { ...b.barnaby, rating: null } } : b));
  },
  async editBook(id, patch) {
    const i = inbox.find((b) => b.id === id);
    if (!i) notFound();
    Object.assign(i, patch, patch.rating !== undefined ? { ratingSource: patch.rating ? "admin" : null } : {});
    return delay({ ...i, publisher: null, language: null, approved: false });
  },
  async mergeBook(id) {
    inbox = inbox.filter((b) => b.id !== id);
  },
  async refreshMetadata() {
    await delay(null);
  },
  coverUrl: (b) => b.coverPath,

  people: () =>
    delay({
      users: people,
      household: people.filter((p) => !p.disabled).map(({ id, displayName, avatar, role }) => ({ id, displayName, avatar, role })),
    }),
  async addPerson(p) {
    const u = user({
      id: crypto.randomUUID(),
      displayName: p.displayName,
      role: p.role,
      birthYear: p.birthYear ?? null,
      avatar: p.avatar ?? null,
      kidSignInMethod: p.role === "kid" ? (p.kidSignInMethod ?? "picture") : null,
      signIn: p.role === "kid" ? (p.pin ? "pin" : p.pictures ? "picture" : "none") : p.email ? "google" : p.password ? "password" : "none",
      parentIds: p.role === "kid" ? [...new Set(["u-adult", ...(p.parentIds ?? [])])] : [],
      createdAt: Date.now(),
    });
    people = [...people, u];
    return delay(u);
  },
  async updatePerson(id, patch) {
    people = people.map((p) => (p.id === id ? { ...p, ...patch } : p));
    return delay(people.find((p) => p.id === id) ?? notFound());
  },
  async setSecret(id, secret) {
    const signIn = "pin" in secret ? "pin" : "pictures" in secret ? "picture" : "password";
    people = people.map((p) => (p.id === id ? { ...p, signIn, ...(signIn !== "password" ? { kidSignInMethod: signIn } : {}) } : p));
    return delay(people.find((p) => p.id === id) ?? notFound());
  },
  async linkParent(kidId, parentId) {
    people = people.map((p) => (p.id === kidId ? { ...p, parentIds: [...new Set([...p.parentIds, parentId])] } : p));
    return delay(people.find((p) => p.id === kidId)!);
  },
  async unlinkParent(kidId, parentId) {
    const kid = people.find((p) => p.id === kidId)!;
    if (kid.parentIds.length <= 1) throw Object.assign(new Error("A kid always needs at least one parent"), { status: 400 });
    people = people.map((p) => (p.id === kidId ? { ...p, parentIds: p.parentIds.filter((x) => x !== parentId) } : p));
    return delay(people.find((p) => p.id === kidId)!);
  },

  devices: () => delay(devices),
  async startPairing(name, userId) {
    const code = "KQ7M-4XRT";
    devices = [...devices, { id: crypto.randomUUID(), name, userId, lastSeenAt: null, revokedAt: null, createdAt: Date.now() }];
    return delay({ pairingId: "p1", code, expiresAt: Date.now() + 10 * 60_000, qr: `bookbandit://pair?server=${encodeURIComponent(location.origin)}&code=${code}` });
  },
  async updateDevice(id, patch) {
    devices = devices.map((d) => (d.id === id ? { ...d, ...patch } : d));
    return delay(devices.find((d) => d.id === id)!);
  },
  async revokeDevice(id) {
    devices = devices.map((d) => (d.id === id ? { ...d, revokedAt: Date.now() } : d));
    return delay(devices.find((d) => d.id === id)!);
  },

  absSettings: () => delay(abs),
  async saveAbs(input) {
    abs = { configured: true, enabled: input.enabled, url: input.url, libraryIds: input.libraryIds, hasToken: true };
    return delay(abs);
  },
  testAbs: () =>
    delay({
      ok: true as const,
      username: "bookbandit",
      libraries: [
        { id: "lib1", name: "Audiobooks", mediaType: "book" },
        { id: "lib2", name: "Kids audio", mediaType: "book" },
      ],
    }),
  smtpSettings: () => delay(smtp),
  async saveSmtp(input) {
    const { password, ...rest } = input;
    smtp = { configured: true, ...rest, hasPassword: !!password || (smtp.configured && smtp.hasPassword) };
    return delay(smtp);
  },
  testSmtp: () => delay({ ok: true as const }),
  metadataSettings: () => delay(metadata),
  async saveMetadata(input) {
    metadata = {
      ...metadata,
      online: input.online,
      hasHardcoverToken: input.hardcoverToken === null ? metadata.fromEnv.hardcoverToken : input.hardcoverToken ? true : metadata.hasHardcoverToken,
      hasGoogleApiKey: input.googleApiKey === null ? metadata.fromEnv.googleApiKey : input.googleApiKey ? true : metadata.hasGoogleApiKey,
      hasIsbndbKey: input.isbndbKey === null ? false : input.isbndbKey ? true : metadata.hasIsbndbKey,
      saved: true,
    };
    return delay(metadata);
  },

  familyKids: () =>
    delay(
      people
        .filter((p) => p.role === "kid")
        .map((k) => ({ ...card(k), stats: kidDetails[k.id]?.stats ?? emptyStats() })),
    ),
  async familyKid(id) {
    const k = people.find((p) => p.id === id && p.role === "kid") ?? notFound();
    const d = kidDetails[id] ?? { stats: emptyStats(), reading: [], requests: [], chats: [] };
    return delay({ kid: card(k), ...d });
  },
  familyChat: (_kid, conversationId) => delay(chats[conversationId] ?? notFound()),
  async readingStats(userId, days = 7) {
    const k = people.find((p) => p.id === userId) ?? notFound();
    const pattern: Record<string, number[]> = {
      "u-kid": [12, 0, 18, 25, 9, 31, 14],
      "u-kid2": [40, 35, 0, 52, 47, 61, 22],
    };
    const mins = pattern[userId] ?? Array(7).fill(0);
    const daysOut = Array.from({ length: days }, (_, i) => {
      const m = mins[(i + mins.length - (days % mins.length)) % mins.length] ?? 0;
      return { date: new Date(now - (days - 1 - i) * D).toISOString().slice(0, 10), readSeconds: m * 60, listenSeconds: i % 3 === 0 ? 600 : 0 };
    });
    const reading = kidDetails[userId]?.reading ?? [];
    const total = daysOut.reduce((n, d) => n + d.readSeconds + d.listenSeconds, 0);
    let streak = 0;
    for (let i = daysOut.length - 1; i >= 0 && daysOut[i]!.readSeconds + daysOut[i]!.listenSeconds > 0; i--) streak++;
    return delay({
      user: { id: k.id, displayName: k.displayName },
      totalSeconds: total,
      streakDays: streak,
      days: daysOut,
      books: reading.map((r, i) => ({ id: r.bookId, title: r.title, coverPath: r.coverPath, seconds: Math.round(total * [0.6, 0.3, 0.1][i]!) || 0 })),
    });
  },
};

function emptyStats(): KidStats {
  return { readingNow: 0, finished: 0, finishedLast30Days: 0, booksOpenedLast7Days: 0, lastReadAt: null, lastBook: null, pendingRequests: 0, aiQuestionsLast7Days: 0, aiFlaggedLast7Days: 0 };
}
