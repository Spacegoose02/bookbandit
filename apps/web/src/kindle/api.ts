/** Send to Kindle (apps/server/src/integrations/README.md). Demo mode pretends to send. */
import { isDemo, request } from "../api/client";

export interface KindleMe {
  email: string | null;
  /** Grown-ups set their own address; a kid's is set by a parent. */
  canEdit: boolean;
  /** An admin has set up the email (SMTP) settings. */
  available: boolean;
  /** Add this to Amazon's "Approved Personal Document E-mail List". */
  fromAddress: string | null;
}

export interface KindleApi {
  me(): Promise<KindleMe>;
  setAddress(userId: string, email: string): Promise<{ email: string }>;
  removeAddress(userId: string): Promise<void>;
  send(bookId: string, format?: "epub" | "pdf"): Promise<{ sentTo: string; filename: string; format: string }>;
}

const enc = encodeURIComponent;

export const httpKindleApi: KindleApi = {
  me: () => request("/api/kindle/me"),
  setAddress: (userId, email) => request(`/api/kindle/addresses/${enc(userId)}`, { method: "PUT", body: JSON.stringify({ email }) }),
  removeAddress: (userId) => request(`/api/kindle/addresses/${enc(userId)}`, { method: "DELETE" }),
  send: (bookId, format) =>
    request(`/api/books/${enc(bookId)}/send-to-kindle`, { method: "POST", body: JSON.stringify(format ? { format } : {}) }),
};

const DEMO_KEY = "bb-demo-kindle";
const KINDLE_DOMAINS = ["kindle.com", "free.kindle.com", "kindle.cn"];

export function isKindleAddress(email: string): boolean {
  const m = /^[^\s@]+@([^\s@]+)$/.exec(email.trim().toLowerCase());
  return !!m && KINDLE_DOMAINS.includes(m[1]!);
}

const demoKindleApi: KindleApi = {
  async me() {
    let email: string | null = null;
    try {
      email = localStorage.getItem(DEMO_KEY);
    } catch {
      /* ignore */
    }
    const kid = sessionStorage.getItem("bb-demo-user") === "kid";
    return { email, canEdit: !kid, available: true, fromAddress: "books@example.com" };
  },
  async setAddress(_userId, email) {
    if (!isKindleAddress(email)) throw new Error("Must be a Kindle address (@kindle.com)");
    localStorage.setItem(DEMO_KEY, email.trim().toLowerCase());
    return { email };
  },
  async removeAddress() {
    localStorage.removeItem(DEMO_KEY);
  },
  async send(bookId) {
    await new Promise((r) => setTimeout(r, 600));
    return { sentTo: localStorage.getItem(DEMO_KEY) ?? "", filename: `${bookId}.epub`, format: "epub" };
  },
};

export const kindleApi: KindleApi = isDemo ? demoKindleApi : httpKindleApi;
