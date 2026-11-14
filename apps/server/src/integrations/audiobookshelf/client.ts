/**
 * Minimal Audiobookshelf API client (ABS 2.x). Authenticates with an API token
 * (Settings → Users → your user → API token in ABS). The token never leaves the server:
 * readers get audio through Bookbandit's own proxy routes, which apply the content lock.
 */

export type FetchLike = typeof fetch;

export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: string;
}

export interface AbsItemSummary {
  id: string;
  libraryId: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  narratorName: string | null;
  seriesName: string | null;
  isbn: string | null;
  asin: string | null;
  duration: number;
}

export interface AbsTrack {
  index: number;
  ino: string;
  title: string;
  startOffset: number;
  duration: number;
  mimeType: string;
}

export interface AbsChapter {
  start: number;
  end: number;
  title: string;
}

export interface AbsItemDetail extends AbsItemSummary {
  tracks: AbsTrack[];
  chapters: AbsChapter[];
}

export class AbsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/* Raw shapes, only the fields we use. */
interface RawMetadata {
  title?: string | null;
  subtitle?: string | null;
  authorName?: string | null;
  authors?: { name: string }[];
  narratorName?: string | null;
  narrators?: string[];
  seriesName?: string | null;
  isbn?: string | null;
  asin?: string | null;
}
interface RawAudioFile {
  index?: number;
  ino: string;
  duration?: number;
  mimeType?: string;
  exclude?: boolean;
  metadata?: { filename?: string };
}
interface RawItem {
  id: string;
  libraryId: string;
  mediaType?: string;
  media?: {
    metadata?: RawMetadata;
    duration?: number;
    audioFiles?: RawAudioFile[];
    chapters?: { start: number; end: number; title: string }[];
  };
}

function summarize(raw: RawItem): AbsItemSummary {
  const m = raw.media?.metadata ?? {};
  const files = raw.media?.audioFiles?.filter((f) => !f.exclude) ?? [];
  return {
    id: raw.id,
    libraryId: raw.libraryId,
    title: m.title ?? "",
    subtitle: m.subtitle ?? null,
    authorName: m.authorName ?? m.authors?.map((a) => a.name).join(", ") ?? null,
    narratorName: m.narratorName ?? m.narrators?.join(", ") ?? null,
    seriesName: m.seriesName ?? null,
    isbn: m.isbn ?? null,
    asin: m.asin ?? null,
    duration: raw.media?.duration ?? files.reduce((s, f) => s + (f.duration ?? 0), 0),
  };
}

export function toDetail(raw: RawItem): AbsItemDetail {
  const files = (raw.media?.audioFiles ?? [])
    .filter((f) => !f.exclude)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  let offset = 0;
  const tracks = files.map((f, i) => {
    const t: AbsTrack = {
      index: i,
      ino: f.ino,
      title: f.metadata?.filename ?? `Track ${i + 1}`,
      startOffset: offset,
      duration: f.duration ?? 0,
      mimeType: f.mimeType ?? "audio/mpeg",
    };
    offset += t.duration;
    return t;
  });
  const chapters = (raw.media?.chapters ?? []).map((c) => ({ start: c.start, end: c.end, title: c.title }));
  return { ...summarize(raw), duration: raw.media?.duration ?? offset, tracks, chapters };
}

export class AudiobookshelfClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      headers: this.headers({ Accept: "application/json" }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new AbsError(`Audiobookshelf ${path} returned ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** Checks the URL and token. Returns the ABS username. */
  async ping(): Promise<{ username: string }> {
    const me = await this.json<{ username?: string }>("/api/me");
    return { username: me.username ?? "" };
  }

  async libraries(): Promise<AbsLibrary[]> {
    const res = await this.json<{ libraries: AbsLibrary[] }>("/api/libraries");
    return res.libraries.map((l) => ({ id: l.id, name: l.name, mediaType: l.mediaType }));
  }

  /** Every book item in a library (paged under the hood). */
  async libraryItems(libraryId: string, pageSize = 500): Promise<AbsItemSummary[]> {
    const out: AbsItemSummary[] = [];
    for (let page = 0; ; page++) {
      const res = await this.json<{ results: RawItem[]; total: number }>(
        `/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${pageSize}&page=${page}`,
      );
      out.push(...res.results.map(summarize));
      if (res.results.length < pageSize || out.length >= res.total) return out;
    }
  }

  async item(itemId: string): Promise<AbsItemDetail> {
    const raw = await this.json<RawItem>(`/api/items/${encodeURIComponent(itemId)}?expanded=1`);
    return toDetail(raw);
  }

  /** Streams one audio file. Forwards Range so seeking works. */
  async streamFile(itemId: string, ino: string, range?: string): Promise<Response> {
    const res = await this.fetchImpl(this.url(`/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(ino)}`), {
      headers: this.headers(range ? { Range: range } : {}),
    });
    if (!res.ok && res.status !== 206) throw new AbsError(`Audiobookshelf file returned ${res.status}`, res.status);
    return res;
  }

  async cover(itemId: string): Promise<Response> {
    const res = await this.fetchImpl(this.url(`/api/items/${encodeURIComponent(itemId)}/cover`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new AbsError(`Audiobookshelf cover returned ${res.status}`, res.status);
    return res;
  }
}
