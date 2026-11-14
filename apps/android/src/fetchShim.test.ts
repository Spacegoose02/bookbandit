import { describe, expect, it, vi } from "vitest";
import { encodeBody, makeFetch, routeFor } from "./fetchShim";
import type { NativeRequest } from "./native";

const ORIGIN = "https://localhost";

describe("routeFor", () => {
  it("routes same-origin /api writes natively", () => {
    expect(routeFor("/api/progress/b1", "PUT", ORIGIN)).toEqual({ method: "PUT", path: "/api/progress/b1" });
    expect(routeFor("https://localhost/api/bookmarks?x=1", "post", ORIGIN)).toEqual({ method: "POST", path: "/api/bookmarks?x=1" });
    expect(routeFor("/api/users/me", "PATCH", ORIGIN)?.method).toBe("PATCH");
  });

  it("leaves GETs, other paths and other origins alone", () => {
    expect(routeFor("/api/books", "GET", ORIGIN)).toBeNull();
    expect(routeFor("/api/books", undefined, ORIGIN)).toBeNull();
    expect(routeFor("/assets/app.js", "POST", ORIGIN)).toBeNull();
    expect(routeFor("https://example.com/api/x", "POST", ORIGIN)).toBeNull();
  });
});

describe("encodeBody", () => {
  it("passes strings through and base64s binary", async () => {
    expect(await encodeBody('{"a":1}', {})).toEqual({ body: '{"a":1}' });
    expect(await encodeBody(new Uint8Array([104, 105]), {})).toEqual({ bodyBase64: "aGk=" });
    const h: Record<string, string> = {};
    expect(await encodeBody(new URLSearchParams({ a: "b" }), h)).toEqual({ body: "a=b" });
    expect(h["content-type"]).toMatch(/urlencoded/);
  });

  it("refuses FormData uploads with a clear message", async () => {
    await expect(encodeBody(new FormData(), {})).rejects.toThrow(/browser/);
  });
});

describe("makeFetch", () => {
  it("sends writes through the plugin and builds a Response", async () => {
    const original = vi.fn();
    const sent: NativeRequest[] = [];
    const f = makeFetch(
      original as unknown as typeof fetch,
      async (req) => {
        sent.push(req);
        return { status: 200, headers: { "content-type": "application/json" }, body: '{"status":"applied"}' };
      },
      ORIGIN,
    );
    const res = await f("/api/progress/b1", { method: "PUT", body: '{"x":1}', headers: { "Content-Type": "application/json" } });
    expect(original).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/api/progress/b1", body: '{"x":1}', headers: { "content-type": "application/json" } });
    expect(await res.json()).toEqual({ status: "applied" });
  });

  it("turns a native failure into a network error, like an offline browser", async () => {
    const f = makeFetch(vi.fn() as unknown as typeof fetch, () => Promise.reject({ code: "OFFLINE" }), ORIGIN);
    await expect(f("/api/progress/batch", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(TypeError);
  });

  it("handles 204 with no body", async () => {
    const f = makeFetch(vi.fn() as unknown as typeof fetch, async () => ({ status: 204, headers: {}, body: "" }), ORIGIN);
    const res = await f("/api/bookmarks/x", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("uses the original fetch for GETs", async () => {
    const original = vi.fn().mockResolvedValue(new Response("ok"));
    const f = makeFetch(original as unknown as typeof fetch, vi.fn(), ORIGIN);
    await f("/api/books");
    expect(original).toHaveBeenCalledWith("/api/books", undefined);
  });
});
