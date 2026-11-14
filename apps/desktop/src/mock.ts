/**
 * Browser stand-in for the native side, used by `pnpm dev` outside Tauri and by the screenshot
 * script. `?mock=first-run`, `?mock=offline` and `?mock=empty` pick a starting state.
 */
const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const scenario = params.get("mock") ?? "offline";

const cover = (hue: number, title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,42%)"/><stop offset="1" stop-color="hsl(${hue},60%,22%)"/></linearGradient></defs><rect width="300" height="450" fill="url(#g)"/><text x="150" y="200" font-family="Georgia,serif" font-size="30" fill="#fff" text-anchor="middle">${title}</text></svg>`;

const books = [
  { id: "b1", title: "The Lantern Keeper", authors: ["Ada Moss"], hue: 210, percent: 0.42 },
  { id: "b2", title: "Mapmakers", authors: ["R. Okafor"], hue: 25, percent: 0.08 },
  { id: "b3", title: "Salt and Stars", authors: ["June Park"], hue: 280, percent: 0 },
  { id: "b4", title: "The Quiet Engine", authors: ["Tomas Ruiz"], hue: 150, percent: 1 },
].map((b, i) => ({
  bookId: b.id,
  ownerId: "u1",
  title: b.title,
  authors: b.authors,
  format: "epub",
  fileName: "book.epub",
  hasCover: true,
  sizeBytes: 800_000,
  savedAt: Date.now() - i * 3600_000,
  progress: b.percent
    ? { locator: { kind: "epub", cfi: "", percent: b.percent }, percent: b.percent, finished: b.percent >= 1, updatedAt: Date.now() - i * 60_000, deviceName: "LIVING-ROOM (desktop)" }
    : null,
  hue: b.hue,
}));

let server: string | null = scenario === "first-run" ? null : "https://books.example.com/";

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 150));
  const out = (v: unknown) => v as T;
  switch (cmd) {
    case "app_info":
      return out({ serverUrl: server, deviceName: "LIVING-ROOM (desktop)", version: "0.1.0" });
    case "connect":
      if (String(args.address).includes("wrong")) throw "Couldn't reach the server. Check the address and that this PC is on the same network.";
      server = "https://books.example.com/";
      return out(server);
    case "server_reachable":
      return out(scenario !== "offline" && scenario !== "empty");
    case "open_server":
      throw "This is a preview outside the desktop app, so it can't open the server.";
    case "offline_library":
      return out({
        user: { id: "u1", displayName: "Sam", role: "adult" },
        books: scenario === "empty" ? [] : books,
        pending: scenario === "empty" ? 0 : 2,
      });
    case "offline_cover": {
      const b = books.find((x) => x.bookId === args.bookId);
      return out(new TextEncoder().encode(cover(b?.hue ?? 0, b?.title ?? "")).buffer);
    }
    case "offline_file":
      throw "Reading needs the desktop app.";
    case "offline_progress":
    case "offline_remove":
      return out(undefined);
    case "sync_now":
      throw "Couldn't reach the server (offline).";
    default:
      throw `unknown command ${cmd}`;
  }
}
