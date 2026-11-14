import { describe, expect, it } from "vitest";
import { insecureWarning, isPlausibleCode, isValidPin, normalizeCode, normalizeServer, parsePairLink } from "./pairing";

describe("parsePairLink", () => {
  it("reads the server's QR payload", () => {
    const qr = `bookbandit://pair?${new URLSearchParams({ server: "https://books.example.com", code: "K7QM-4XPA" })}`;
    expect(parsePairLink(qr)).toEqual({ server: "https://books.example.com", code: "K7QM-4XPA" });
  });

  it("works without a server (the code can still be typed with an address)", () => {
    expect(parsePairLink("bookbandit://pair?code=abcd-efgh")).toEqual({ server: null, code: "ABCD-EFGH" });
  });

  it("ignores other QR codes", () => {
    expect(parsePairLink("https://example.com/menu")).toBeNull();
    expect(parsePairLink("bookbandit://other?code=x")).toBeNull();
    expect(parsePairLink("hello")).toBeNull();
    expect(parsePairLink("")).toBeNull();
  });

  it("normalizes the server inside the link", () => {
    expect(parsePairLink("bookbandit://pair?server=http%3A%2F%2F192.168.1.20%3A8080%2F&code=x1y2z3w4")?.server).toBe(
      "http://192.168.1.20:8080",
    );
  });
});

describe("normalizeServer", () => {
  it("adds a scheme: http for LAN, https for names", () => {
    expect(normalizeServer("192.168.1.20:8080")).toBe("http://192.168.1.20:8080");
    expect(normalizeServer("nas.local:8080")).toBe("http://nas.local:8080");
    expect(normalizeServer("unraid:8080")).toBe("http://unraid:8080");
    expect(normalizeServer("books.example.com")).toBe("https://books.example.com");
  });

  it("drops trailing slashes and anything from /api on, keeps a sub-path", () => {
    expect(normalizeServer("https://books.example.com/")).toBe("https://books.example.com");
    expect(normalizeServer("https://example.com/bookbandit/api/users/me")).toBe("https://example.com/bookbandit");
  });

  it("rejects non-addresses", () => {
    expect(normalizeServer("")).toBeNull();
    expect(normalizeServer("ftp://x.com")).toBeNull();
    expect(normalizeServer("http://")).toBeNull();
  });
});

describe("codes and PINs", () => {
  it("normalizes codes", () => {
    expect(normalizeCode(" k7qm 4xpa ")).toBe("K7QM4XPA");
    expect(isPlausibleCode("k7qm-4xpa")).toBe(true);
    expect(isPlausibleCode("abc")).toBe(false);
  });

  it("PINs are 4 to 8 digits", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("12ab")).toBe(false);
  });
});

describe("insecureWarning", () => {
  it("warns only for plain http to internet hosts", () => {
    expect(insecureWarning("http://192.168.1.20:8080")).toBeNull();
    expect(insecureWarning("http://10.0.0.5")).toBeNull();
    expect(insecureWarning("http://nas.local")).toBeNull();
    expect(insecureWarning("https://books.example.com")).toBeNull();
    expect(insecureWarning("http://books.example.com")).toMatch(/isn't encrypted/);
  });
});
