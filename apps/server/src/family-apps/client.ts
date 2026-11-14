/** Calls to the other family apps: a bearer token, JSON, a short timeout, and a plain error message. */
import { USER_AGENT, type FetchLike } from "../metadata/providers/http.js";
import type { SecretBox } from "../integrations/secrets.js";

export class AppCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface Linked {
  url: string;
  homeId: string;
  token: string;
}

export function makeCaller(fetchImpl: FetchLike, box: SecretBox, appName: string) {
  return async function call<T>(link: Linked, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${link.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${box.open(link.token)}`,
          "user-agent": USER_AGENT,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppCallError(`Couldn't reach ${appName} at ${link.url}`, null);
    }
    if (res.status === 401 || res.status === 403) throw new AppCallError(`${appName} didn't accept the token`, res.status);
    if (res.status === 404) throw new AppCallError(`${appName} doesn't know that home (or is too old for this)`, 404);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = "";
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        msg = j.message ?? j.error ?? "";
      } catch {
        /* not JSON */
      }
      throw new AppCallError(`${appName} said ${res.status}${msg ? `: ${msg}` : ""}`, res.status);
    }
    return (await res.json()) as T;
  };
}
