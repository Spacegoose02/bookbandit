import { afterEach, describe, expect, it, vi } from "vitest";
import { httpDiscoverApi } from "./api";

const input = { title: "Dune", author: "Frank Herbert", isbn13: null };
const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

afterEach(() => vi.unstubAllGlobals());

describe("requestBook", () => {
  it("reports a sent request", async () => {
    reply(201, { id: "r1" });
    expect(await httpDiscoverApi.requestBook(input)).toEqual({ status: "sent" });
  });
  it("turns 409 already_in_library into a link to the book", async () => {
    reply(409, { error: "already_in_library", book: { id: "b1", title: "Dune" } });
    expect(await httpDiscoverApi.requestBook(input)).toEqual({ status: "in_library", book: { id: "b1", title: "Dune" } });
  });
  it("says requests are unavailable when the endpoint is missing", async () => {
    reply(404, { message: "Not found" });
    expect(await httpDiscoverApi.requestBook(input)).toEqual({ status: "unavailable" });
  });
  it("throws other errors", async () => {
    reply(409, { error: "something_else", message: "Nope" });
    await expect(httpDiscoverApi.requestBook(input)).rejects.toThrow("Nope");
  });
});
