export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Generic client name only: never send anything that identifies the household. */
export const USER_AGENT = "Bookbandit/0.1 (self-hosted family library)";

export async function getJson<T>(fetchFn: FetchLike, url: string, init: RequestInit = {}): Promise<T | undefined> {
  const res = await fetchFn(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}
