import type { NativeRequest, NativeResponse } from "./native";

/**
 * Sends the web app's /api requests that carry a body (POST, PUT, PATCH, DELETE) through the
 * native plugin. GET requests (JSON, covers, book files) don't need this: the native WebView
 * client answers them directly. Both add the device token natively, so it never reaches the page.
 */

type Send = (req: NativeRequest) => Promise<NativeResponse>;

export interface Routed {
  method: string;
  path: string;
}

/** Which requests go native: same-origin /api with a method other than GET/HEAD. */
export function routeFor(url: string, method: string | undefined, origin: string): Routed | null {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || !u.pathname.startsWith("/api/")) return null;
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return null;
  return { method: m, path: u.pathname + u.search };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Turns a fetch body into what the plugin takes. FormData (file uploads) isn't supported yet. */
export async function encodeBody(
  body: BodyInit | null | undefined,
  headers: Record<string, string>,
): Promise<Pick<NativeRequest, "body" | "bodyBase64">> {
  if (body == null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof URLSearchParams) {
    if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    return { body: body.toString() };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    throw new TypeError("Uploading files isn't supported in the tablet app yet. Use a browser.");
  }
  if (body instanceof Blob) {
    if (body.type && !hasHeader(headers, "content-type")) headers["content-type"] = body.type;
    return { bodyBase64: toBase64(new Uint8Array(await body.arrayBuffer())) };
  }
  if (body instanceof ArrayBuffer) return { bodyBase64: toBase64(new Uint8Array(body)) };
  if (ArrayBuffer.isView(body)) return { bodyBase64: toBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
  throw new TypeError("Unsupported request body");
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name);
}

export function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** A fetch that sends routed requests natively and everything else to the original fetch. */
export function makeFetch(original: typeof fetch, send: Send, origin: string): typeof fetch {
  return async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = isRequest ? (input as Request).url : String(input);
    const method = init?.method ?? (isRequest ? (input as Request).method : "GET");
    const route = routeFor(url, method, origin);
    if (!route) return original(input as RequestInfo, init);

    const signal = init?.signal ?? (isRequest ? (input as Request).signal : undefined);
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

    const headers = headersToObject(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
    let body: BodyInit | null | undefined = init?.body;
    if (body === undefined && isRequest) body = await (input as Request).clone().arrayBuffer();
    const encoded = await encodeBody(body, headers);

    let res: NativeResponse;
    try {
      res = await send({ method: route.method, path: route.path, headers, ...encoded });
    } catch {
      // Same as a browser that can't reach the server, so offline queues keep working.
      throw new TypeError("Failed to fetch");
    }
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBody ? null : res.body, { status: res.status, headers: res.headers });
  };
}
